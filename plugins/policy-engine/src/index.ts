import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-skill'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  decideAction,
  fingerprint,
  type PolicyAuthority,
  type PolicyDecision,
  type PolicyRule,
  refusal,
} from '@loncothad/dsh-execution-core'
import {
  editableConfig,
  managedApply,
  PluginState,
  registerStatus,
} from '@loncothad/dsh-plugin-runtime'
import { rulesSchema, schema } from './config.ts'
import {
  type ActionScope,
  matchesGrant,
  permissionsSchema,
  type Similarity,
  similarity,
} from './permissions.ts'
import { contribution } from './wire.ts'
export const name = 'policy-engine'
export const inject = ['tools', 'agents', 'commands']
export const Config = editableConfig(schema)
type Policy = {
  stateDirectory?: string
  mode: 'off' | 'observe' | 'enforce'
  environment: 'dev' | 'staging' | 'prod'
  defaultEffect: PolicyRule['effect']
  honorFullAccess: boolean
  rules: PolicyRule[]
  allowWorkspaceInspection: boolean
  rememberSimilar: boolean
  similarApprovalMs: number
  approvalTimeoutMs: number
  skillEnabled: boolean
}
interface Gate {
  current?: PolicyAuthority
  view?: () => { ready: boolean; message: string; fields: { label: string; value: string }[] }
}
async function activate(ctx: Context, input: Partial<Policy>, gate: Gate): Promise<void> {
  const policy = schema(input) as Policy
  policy.rules = rulesSchema.parse(policy.rules)
  const lifetime = new AbortController(),
    approved = new WeakMap<ToolExecution, string>(),
    prepared = new WeakMap<ToolExecution, string>()
  const permissions = await PluginState.open(
    ctx,
    'policyPermissions',
    () => ({ grants: [] }),
    (v) => permissionsSchema.parse(v),
    { directory: policy.stateDirectory },
  )
  const policyHash = fingerprint(policy),
    pending = new Map<
      string,
      {
        exec: ToolExecution
        hash: string
        candidate?: Similarity
        scope: ActionScope
        signal: AbortSignal
        remember?: boolean
      }
    >()
  const pendingKey = (sessionId: string, callId: string) => fingerprint({ sessionId, callId })
  const scopeOf = (sessionId: string): ActionScope => {
    const agent = ctx.agents.get(SessionId(sessionId)),
      boundary = ctx.get('environmentIsolation'),
      sandbox = agent ? ctx.get('sandboxPolicy')?.resolve({ session: agent.session }) : undefined
    return {
      sessionId,
      environment: boundary?.environment ?? policy.environment,
      workspace: sandbox?.workspaceRoot ?? agent?.session.header.cwd ?? process.cwd(),
      mode: sandbox?.mode ?? 'unavailable',
      boundary: boundary?.scope(sessionId) ?? policy.environment,
    }
  }
  const baseInspect = (sessionId: string, tool: string, args: unknown): PolicyDecision => {
    const boundary = ctx.get('environmentIsolation'),
      evidence = ctx.get('evidenceAuthority')
    const target = evidence?.currentTarget(sessionId) ?? fingerprint({ sessionId })
    if (boundary && !boundary.valid)
      return {
        effect: 'deny',
        requestHash: fingerprint({ sessionId, tool, args }),
        ruleIds: [],
        reason: refusal('missing_permissions', 'ENVIRONMENT_BOUNDARY', boundary.reason),
      }
    return decideAction(
      {
        sessionId,
        tool,
        arguments: args,
        environment: boundary?.environment ?? policy.environment,
        target,
      },
      policy.rules,
      policy.defaultEffect,
      (contract) =>
        evidence?.check(sessionId, contract) ?? {
          state: 'insufficient_evidence',
          missing: ['Evidence Assurance is unavailable'],
          receiptIds: [],
        },
    )
  }
  const inspect = (sessionId: string, tool: string, args: unknown): PolicyDecision => {
    const decision = baseInspect(sessionId, tool, args)
    if (decision.effect !== 'require_review') return decision
    const scope = scopeOf(sessionId),
      candidate = similarity(tool, args, scope, policyHash),
      agent = ctx.agents.get(SessionId(sessionId))
    // The native preset records operator intent. A bare Never policy, Auto
    // review or a full-access executor does not grant this policy exception.
    if (
      policy.honorFullAccess &&
      !decision.ruleIds.length &&
      agent &&
      scope.mode === 'danger-full-access' &&
      ctx.get('permissionPresets')?.current(agent.session) === 'danger-full-access' &&
      (ctx.get('approval')?.overrideOf(agent.session) ?? ctx.get('approval')?.config.policy) ===
        'never'
    )
      return { ...decision, effect: 'allow' }
    if (
      policy.allowWorkspaceInspection &&
      !decision.ruleIds.length &&
      candidate?.label === 'Directory listings in this workspace'
    )
      return { ...decision, effect: 'allow' }
    if (policy.rememberSimilar && candidate && agent) {
      try {
        if (
          permissions
            .get(agent.session)
            .grants.some((g) => matchesGrant(g, candidate, scope, policyHash, decision))
        )
          return { ...decision, effect: 'allow' }
      } catch {
        /* A session without restored permissions has no remembered grant. */
      }
    }
    return decision
  }
  ctx.inject(['typert', 'sessions'], (scope) => {
    class Permissions extends TypertRemoteService {
      constructor() {
        super(scope, 'policyPermissions')
        scope.typert.register({
          package: contribution.package,
          face: 'host',
          model: { services: [], events: [], objects: [] },
          schemas: [],
          invocations: contribution.descriptors,
        })
      }
      private session(id: string) {
        if (!this.ctx.invocation)
          throw Error('Permission changes require the authenticated human Gateway')
        const session = scope.sessions.get(SessionId(id))
        if (!session) throw Error('Open this chat before changing permissions')
        return session
      }
      async read(id: string) {
        const session = this.session(id)
        await permissions.ensure(session)
        return JSON.stringify({
          grants: permissions
            .get(session)
            .grants.filter(
              (g) => g.sessionId === id && g.policyHash === policyHash && g.expiresAt > Date.now(),
            )
            .map(({ id, label, workspace, expiresAt }) => ({ id, label, workspace, expiresAt })),
          pending: [...pending.values()]
            .filter((p) => p.exec.agent?.id === id && !p.signal.aborted)
            .map((p) => ({
              callId: p.exec.callId,
              requestHash: p.hash,
              label: p.candidate?.label ?? 'This action requires a separate review',
              workspace: p.scope.workspace,
              canRemember: policy.rememberSimilar && Boolean(p.candidate),
            })),
        })
      }
      async remember(id: string, callId: string, requestHash: string) {
        this.session(id)
        const request = pending.get(pendingKey(id, callId))
        if (
          !request ||
          request.signal.aborted ||
          request.hash !== requestHash ||
          !request.candidate ||
          !policy.rememberSimilar
        )
          throw Error('This approval is unavailable or changed')
        const decision = baseInspect(id, request.exec.name, request.exec.arguments)
        if (decision.effect !== 'require_review' || decision.requestHash !== requestHash)
          throw Error('The action or its evidence changed; review again')
        const candidate = similarity(
          request.exec.name,
          request.exec.arguments,
          scopeOf(id),
          policyHash,
        )
        if (candidate?.signature !== request.candidate.signature)
          throw Error('The permission scope changed')
        request.signal.throwIfAborted()
        request.remember = true
        return JSON.stringify({
          label: candidate.label,
          expiresAt: Date.now() + policy.similarApprovalMs,
        })
      }
      async revoke(id: string, grantId: string) {
        const session = this.session(id)
        await permissions.ensure(session)
        await permissions.update(session, (state) => ({
          grants: state.grants.filter((g) => g.sessionId !== id || g.id !== grantId),
        }))
        return 'revoked'
      }
    }
    new Permissions()
  })
  const service: PolicyAuthority = { inspect }
  if (policy.mode !== 'off') {
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (policy.mode === 'observe') return next()
      if (!exec.agent)
        return {
          kind: 'deny',
          reason: JSON.stringify(
            refusal(
              'missing_permissions',
              'MISSING_SESSION',
              'Policy requires a live session identity.',
            ),
          ),
        }
      await permissions.ensure(exec.agent.session)
      await ctx.get('evidenceAuthority')?.refresh(exec.agent.id)
      const decision = inspect(exec.agent.id, exec.name, exec.arguments)
      prepared.set(exec, decision.requestHash)
      if (decision.effect === 'deny')
        return { kind: 'deny', reason: JSON.stringify(decision.reason) }
      if (decision.effect === 'require_review') {
        const approval = ctx.get('approval')
        if (!approval)
          return {
            kind: 'deny',
            reason: JSON.stringify(
              refusal(
                'missing_permissions',
                'APPROVAL_UNAVAILABLE',
                'Native human approval is unavailable.',
              ),
            ),
          }
        if (
          (approval.overrideOf(exec.agent.session) ?? approval.config.policy ?? 'ask') === 'never'
        )
          return {
            kind: 'deny',
            reason: JSON.stringify(
              refusal(
                'missing_permissions',
                'APPROVAL_DISABLED',
                `Policy Engine requires review for ${exec.name} (${decision.ruleIds.length ? `rules: ${decision.ruleIds.join(', ')}` : 'default decision'}), but DSH approval prompts are set to Never. Change the matching Policy Engine rule or enable Ask. Full Access honors only unmatched default reviews when Honor Full Access is enabled. This is a configuration conflict; retrying the same action will not resolve it.`,
              ),
            ),
          }
        if (pending.size >= 128)
          return {
            kind: 'deny',
            reason: JSON.stringify(
              refusal('transient_failure', 'REVIEW_CAPACITY', 'Too many pending policy reviews.'),
            ),
          }
        const signal = AbortSignal.any([
          exec.signal,
          lifetime.signal,
          AbortSignal.timeout(policy.approvalTimeoutMs),
        ])
        const key = pendingKey(exec.agent.id, exec.callId),
          scope = scopeOf(exec.agent.id)
        pending.set(key, {
          exec,
          hash: decision.requestHash,
          candidate: similarity(exec.name, exec.arguments, scope, policyHash),
          scope,
          signal,
        })
        try {
          const result = await approval.request({
            agent: exec.agent,
            toolName: exec.name,
            callId: exec.callId,
            reason: `Policy review: ${exec.name}. Review this action before it runs.`,
            signal,
          })
          signal.throwIfAborted()
          if (result !== 'allowed-once')
            return {
              kind: 'deny',
              reason: JSON.stringify(
                refusal('missing_permissions', 'APPROVAL_REJECTED', 'The action was not approved.'),
              ),
            }
          const request = pending.get(key)
          if (request?.remember && request.candidate) {
            const current = baseInspect(exec.agent.id, exec.name, exec.arguments)
            const candidate = similarity(
              exec.name,
              exec.arguments,
              scopeOf(exec.agent.id),
              policyHash,
            )
            if (
              current.effect !== 'require_review' ||
              current.requestHash !== request.hash ||
              candidate?.signature !== request.candidate.signature
            )
              throw Error('The approved action or scope changed')
            const now = Date.now()
            await permissions.update(exec.agent.session, (state) => ({
              grants: [
                ...state.grants.filter((g) => g.expiresAt > now && g.id !== candidate.signature),
                {
                  id: candidate.signature,
                  signature: candidate.signature,
                  policyHash,
                  sessionId: exec.agent!.id,
                  label: candidate.label,
                  workspace: candidate.workspace,
                  environment: request.scope.environment,
                  mode: request.scope.mode,
                  expiresAt: now + policy.similarApprovalMs,
                  createdAt: now,
                },
              ].slice(-32),
            }))
          }
          approved.set(exec, decision.requestHash)
        } catch {
          return {
            kind: 'deny',
            reason: JSON.stringify(
              refusal(
                'missing_permissions',
                'APPROVAL_CANCELLED',
                'Approval was cancelled or timed out.',
              ),
            ),
          }
        } finally {
          pending.delete(key)
        }
      }
      return next()
    })
    ctx.tools.guard((exec) => {
      if (policy.mode !== 'enforce') return undefined
      if (!exec.agent)
        return JSON.stringify(
          refusal(
            'missing_permissions',
            'MISSING_SESSION',
            'Policy requires a live session identity.',
          ),
        )
      const decision = inspect(exec.agent.id, exec.name, exec.arguments)
      if (decision.effect === 'deny') return JSON.stringify(decision.reason)
      if (
        policy.rules.some((rule) => rule.evidenceContract && decision.ruleIds.includes(rule.id)) &&
        prepared.get(exec) !== decision.requestHash
      )
        return JSON.stringify(
          refusal(
            'missing_evidence',
            'EVIDENCE_PREPARATION_REQUIRED',
            'Evidence preparation must match the final action.',
          ),
        )
      if (decision.effect === 'require_review' && approved.get(exec) !== decision.requestHash)
        return JSON.stringify(
          refusal(
            'missing_permissions',
            'EXACT_APPROVAL_REQUIRED',
            'Approval must match the exact action, environment and evidence target.',
          ),
        )
      return undefined
    })
    const audit = await PluginState.open<unknown[]>(
      ctx,
      'policy-audit',
      () => [],
      (value) => {
        if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid policy audit')
        return value
      },
      { directory: policy.stateDirectory },
    )
    ctx.on('tools/result', (exec, result) => {
      if (!exec.agent) return undefined
      const decision = inspect(exec.agent.id, exec.name, exec.arguments)
      void audit
        .update(exec.agent.session, (rows) =>
          [
            ...rows,
            {
              requestHash: decision.requestHash,
              tool: exec.name,
              effect: decision.effect,
              mode: policy.mode,
              ruleIds: decision.ruleIds,
              denied: result.isError,
              ...(decision.reason ? { reasonKind: decision.reason.kind } : {}),
            },
          ].slice(-32),
        )
        .catch(() => {
          gate.current = undefined
        })
      return undefined
    })
  }
  ctx.commands.register({
    name: 'policy',
    description: 'Inspect the active execution policy and refusal vocabulary',
    handler: (invocation) => {
      invocation.signal.throwIfAborted()
      return {
        kind: 'success',
        text: JSON.stringify(
          {
            mode: policy.mode,
            environment: ctx.get('environmentIsolation')?.environment ?? policy.environment,
            defaultEffect: policy.defaultEffect,
            honorFullAccess: policy.honorFullAccess,
            permissionPreset: ctx.get('permissionPresets')?.current(invocation.agent.session),
            rules: policy.rules,
            refusalKinds: [
              'safety_refusal',
              'missing_permissions',
              'missing_evidence',
              'unsupported_capability',
              'transient_failure',
            ],
          },
          null,
          2,
        ),
      }
    },
  })
  if (policy.skillEnabled)
    ctx.inject(['skills'], (scope) => {
      scope.skills.register({
        name: 'execution-policy',
        source: 'bundled',
        description:
          'Interpret host policy denials and report explicit evidence states without inventing permission or numeric confidence.',
        content:
          'A model answer is not permission and is not proof. Respect host policy and native approvals. Report output as verified only when the host supplies passed evidence criteria; otherwise use unverified or insufficient_evidence and list missing checks. Explain refusals with the host category: safety_refusal, missing_permissions, missing_evidence, unsupported_capability or transient_failure. Do not turn a refusal into a new permission, fabricate review, weaken a rule or blindly retry an operation whose outcome is unknown.',
      })
    })
  gate.current = service
  gate.view = () => ({
    ready: true,
    message: `Policy mode: ${policy.mode}.`,
    fields: [
      { label: 'Default outcome', value: policy.defaultEffect },
      {
        label: 'Full Access',
        value: policy.honorFullAccess ? 'Honor native preset for default reviews' : 'Keep reviews',
      },
      { label: 'Rules', value: String(policy.rules.length) },
      {
        label: 'Environment',
        value: ctx.get('environmentIsolation')?.environment ?? policy.environment,
      },
      {
        label: 'Evidence authority',
        value: ctx.get('evidenceAuthority')
          ? 'Available'
          : 'Unavailable; evidence requirements deny',
      },
    ],
  })
  ctx.effect(
    () => () => {
      if (gate.current === service) {
        gate.current = undefined
        gate.view = undefined
      }
      lifetime.abort()
      pending.clear()
    },
    'policy-engine: withdraw authority and cancel pending reviews',
  )
}
const mount = managedApply(schema, activate)
export function apply(ctx: Context, input: Parameters<typeof mount>[1]): ReturnType<typeof mount> {
  const gate: Gate = {}
  const unavailable = () =>
    refusal(
      'missing_permissions',
      'POLICY_AUTHORITY_UNAVAILABLE',
      'Policy authority is unavailable or its configuration is invalid.',
    )
  ctx.provide('policyEngine', {
    inspect: (sessionId, tool, args) =>
      gate.current?.inspect(sessionId, tool, args) ?? {
        effect: 'deny',
        requestHash: fingerprint({ sessionId, tool }),
        ruleIds: [],
        reason: unavailable(),
      },
  })
  ctx.tools.guard(() => (gate.current ? undefined : JSON.stringify(unavailable())))
  registerStatus(
    ctx,
    'policy',
    () => gate.view?.() ?? { ready: false, message: unavailable().message, fields: [] },
  )
  return mount(ctx, input, gate)
}
