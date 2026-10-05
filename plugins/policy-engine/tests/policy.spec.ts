import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import Approval, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { expect, it } from 'vitest'
import { apply } from '../src/index.ts'

async function fixture() {
  const ctx = new Context(),
    directory = await mkdtemp(join(tmpdir(), 'dsh-policy-private-'))
  ctx.effect(() => () => rm(directory, { recursive: true, force: true }), 'fixture cleanup')
  for (const service of [
    SessionStore,
    ProjectionRegistry,
    AgentRegistry,
    CommandRuntime,
    ToolRuntime,
    SystemPrompt,
  ])
    await ctx.plugin(service)
  const session = ctx.sessions.create(SessionId('policy-test'))
  const agent: Agent = {
    id: session.id,
    session,
    ctx,
    options: {},
    status: 'idle',
    inbox: unsupportedInbox(),
    send() {},
    followup() {},
    steer() {},
    inject() {},
    cancel() {},
    runMaintenance: (task) => task(new AbortController().signal),
    whenIdle: async () => {},
  }
  await ctx.agents.register(agent)
  let executions = 0
  ctx.tools.register(
    defineTool({
      name: 'publish',
      description: 'Controlled consequential operation',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute: async () => {
        executions++
        return 'published'
      },
    }),
  )
  const run = () =>
    ctx.tools.execute({
      agent,
      name: 'publish',
      callId: ToolCallId('action'),
      arguments: {},
      signal: new AbortController().signal,
    })
  return { directory, ctx, agent, run, executions: () => executions }
}
async function nativePermissions(f: Awaited<ReturnType<typeof fixture>>) {
  await f.ctx.plugin(Approval, { policy: 'ask' })
  await f.ctx.plugin(SandboxPolicy, { mode: 'workspace-write' })
  f.ctx.provide('shell', { sandboxMode: 'workspace-write' } as never)
  await f.ctx.plugin(PermissionPresets, {})
  f.ctx.permissionPresets.set(f.agent.session, 'danger-full-access')
}
it('honors the real Full Access preset for default reviews and rechecks changes before dispatch', async () => {
  const f = await fixture()
  try {
    await nativePermissions(f)
    await apply(f.ctx, { stateDirectory: f.directory, rules: [], skillEnabled: false })
    expect((await f.run()).isError).toBe(false)
    expect(f.executions()).toBe(1)
    const remove = f.ctx.tools.guard(() => 'Native guard denial')
    expect(JSON.stringify(await f.run())).toContain('Native guard denial')
    remove()
    f.ctx.on('tools/pre-execute', async (_exec, next) => {
      f.ctx.permissionPresets.set(f.agent.session, 'workspace-write')
      setApprovalPolicy(f.agent.session, 'never')
      return next()
    })
    expect(JSON.stringify(await f.run())).toContain('EXACT_APPROVAL_REQUIRED')
    expect(f.executions()).toBe(1)
    expect(JSON.stringify(await f.run())).toContain('APPROVAL_DISABLED')
  } finally {
    await f.ctx.fiber.dispose()
  }
})
it.each(['deny', 'require_review'] as const)(
  'keeps explicit %s rules authoritative in Full Access',
  async (effect) => {
    const f = await fixture()
    try {
      await nativePermissions(f)
      await apply(f.ctx, {
        stateDirectory: f.directory,
        rules: [{ id: 'controlled-publish', tools: ['publish'], environments: ['dev'], effect }],
        skillEnabled: false,
      })
      const result = JSON.stringify(await f.run())
      expect(f.executions()).toBe(0)
      if (effect === 'require_review') {
        expect(result).toContain('APPROVAL_DISABLED')
        expect(result).toContain('controlled-publish')
        expect(result).toContain('retrying the same action will not resolve it')
      } else expect(result).toContain('missing_permissions')
    } finally {
      await f.ctx.fiber.dispose()
    }
  },
)
it('allows retaining default reviews in Full Access explicitly', async () => {
  const f = await fixture()
  try {
    await nativePermissions(f)
    await apply(f.ctx, {
      stateDirectory: f.directory,
      rules: [],
      honorFullAccess: false,
      skillEnabled: false,
    })
    expect(JSON.stringify(await f.run())).toContain('APPROVAL_DISABLED')
    expect(f.executions()).toBe(0)
  } finally {
    await f.ctx.fiber.dispose()
  }
})
it('does not treat delegated Auto review with Never as Full Access', async () => {
  const f = await fixture()
  try {
    await nativePermissions(f)
    f.ctx.permissionPresets.registerAuto(() => {})
    f.ctx.permissionPresets.set(f.agent.session, 'auto')
    setApprovalPolicy(f.agent.session, 'never')
    expect(f.ctx.permissionPresets.current(f.agent.session)).toBe('auto')
    await apply(f.ctx, { stateDirectory: f.directory, rules: [], skillEnabled: false })
    expect(JSON.stringify(await f.run())).toContain('APPROVAL_DISABLED')
    expect(f.executions()).toBe(0)
  } finally {
    await f.ctx.fiber.dispose()
  }
})
it('does not infer Full Access from executor mode and Never without a native preset', async () => {
  const f = await fixture()
  try {
    await f.ctx.plugin(Approval, { policy: 'never' })
    await f.ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
    await apply(f.ctx, { stateDirectory: f.directory, rules: [], skillEnabled: false })
    expect(JSON.stringify(await f.run())).toContain('APPROVAL_DISABLED')
    expect(f.executions()).toBe(0)
  } finally {
    await f.ctx.fiber.dispose()
  }
})
it('enforces a final denial even when an earlier listener bypasses pre-execution middleware', async () => {
  const f = await fixture()
  try {
    await nativePermissions(f)
    await apply(f.ctx, {
      stateDirectory: f.directory,
      defaultEffect: 'deny',
      rules: [],
      skillEnabled: false,
    })
    f.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
    const result = await f.run()
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('missing_permissions')
    expect(f.executions()).toBe(0)
  } finally {
    await f.ctx.fiber.dispose()
  }
})
it('does not substitute human review or model text for missing evidence', async () => {
  const f = await fixture()
  try {
    await nativePermissions(f)
    f.ctx.provide('evidenceAuthority', {
      currentTarget: () => 'target',
      refresh: async () => {},
      check: () => ({
        state: 'insufficient_evidence',
        missing: ['fresh database-read receipt'],
        receiptIds: [],
      }),
    })
    await apply(f.ctx, {
      stateDirectory: f.directory,
      rules: [
        {
          id: 'release',
          tools: ['publish'],
          environments: ['dev'],
          effect: 'allow',
          evidenceContract: 'release',
        },
      ],
      skillEnabled: false,
    })
    const result = await f.run()
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('missing_evidence')
    expect(f.executions()).toBe(0)
  } finally {
    await f.ctx.fiber.dispose()
  }
})
it('keeps invalid environment boundaries closed in Full Access', async () => {
  const f = await fixture()
  try {
    await nativePermissions(f)
    f.ctx.provide('environmentIsolation', {
      valid: false,
      environment: 'prod',
      reason: 'Invalid production boundary',
      scope: () => 'invalid',
      assert: () => {
        throw Error('Invalid production boundary')
      },
    } as never)
    await apply(f.ctx, { stateDirectory: f.directory, rules: [], skillEnabled: false })
    // Exercise the independent final policy guard even if middleware skips preparation.
    f.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
    expect(JSON.stringify(await f.run())).toContain('ENVIRONMENT_BOUNDARY')
    expect(f.executions()).toBe(0)
  } finally {
    await f.ctx.fiber.dispose()
  }
})
it('requires preparation of exact evidence after a middleware bypass and rejects missing approval support', async () => {
  const f = await fixture()
  try {
    f.ctx.provide('evidenceAuthority', {
      currentTarget: () => 'target',
      refresh: async () => {},
      check: () => ({ state: 'verified', missing: [], receiptIds: ['receipt'] }),
    })
    await apply(f.ctx, {
      stateDirectory: f.directory,
      rules: [
        {
          id: 'release',
          tools: ['publish'],
          environments: ['dev'],
          effect: 'allow',
          evidenceContract: 'release',
        },
      ],
      skillEnabled: false,
    })
    const dispose = f.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), {
      prepend: true,
    })
    expect(JSON.stringify(await f.run())).toContain('EVIDENCE_PREPARATION_REQUIRED')
    expect(f.executions()).toBe(0)
    dispose()
    expect((await f.run()).isError).toBe(false)
    expect(f.executions()).toBe(1)
  } finally {
    await f.ctx.fiber.dispose()
  }
  const review = await fixture()
  try {
    await apply(review.ctx, { stateDirectory: review.directory, rules: [], skillEnabled: false })
    expect(JSON.stringify(await review.run())).toContain('APPROVAL_UNAVAILABLE')
    expect(review.executions()).toBe(0)
  } finally {
    await review.ctx.fiber.dispose()
  }
})
it('keeps Observe behavior separate from enforcement and preserves native denials', async () => {
  const f = await fixture()
  try {
    await apply(f.ctx, {
      stateDirectory: f.directory,
      mode: 'observe',
      defaultEffect: 'deny',
      rules: [],
      skillEnabled: false,
    })
    expect((await f.run()).isError).toBe(false)
    f.ctx.tools.guard(() => 'Native sandbox denial')
    expect((await f.run()).isError).toBe(true)
    expect(f.executions()).toBe(1)
  } finally {
    await f.ctx.fiber.dispose()
  }
})

it('explains disabled native approval without pretending the human rejected it', async () => {
  const f = await fixture()
  try {
    f.ctx.provide('approval', {
      config: { policy: 'never' },
      overrideOf: () => undefined,
      request: async () => {
        throw Error('Must not prompt')
      },
    } as never)
    await apply(f.ctx, { stateDirectory: f.directory, rules: [], skillEnabled: false })
    expect(JSON.stringify(await f.run())).toContain('APPROVAL_DISABLED')
    expect(f.executions()).toBe(0)
  } finally {
    await f.ctx.fiber.dispose()
  }
})

it('remembers only an authenticated human approval, then revokes it and keeps native denials authoritative', async () => {
  const f = await fixture()
  const { default: Registry } = await import('@deepseek-ai/dsh-typert-registry'),
    { default: Gateway } = await import('@deepseek-ai/dsh-api-gateway')
  const peerCtx = new Context()
  const peer = {
    id: 'operator' as import('@deepseek-ai/dsh-typert-protocol').PeerId,
    ctx: peerCtx,
    dispose: () => peerCtx.fiber.dispose(),
  }
  let answer = Promise.withResolvers<'allowed-once' | 'rejected'>(),
    requests = 0
  try {
    await f.ctx.plugin(Registry)
    await f.ctx.plugin(Gateway)
    f.ctx.provide('approval', {
      config: { policy: 'ask' },
      overrideOf: () => undefined,
      request: async () => {
        requests++
        return answer.promise
      },
    } as never)
    await apply(f.ctx, { stateDirectory: f.directory, rules: [], skillEnabled: false })
    const call = async (method: string, args: Record<string, string>) =>
      JSON.parse(
        (await f.ctx.typertGateway.invoke({
          namespace: 'policyPermissions',
          method,
          args,
          peer,
        })) as string,
      )
    const run = f.run()
    await expect.poll(() => requests).toBe(1)
    const pending = (await call('read', { sessionId: f.agent.id })).pending[0]
    expect(pending.canRemember).toBe(true)
    await expect(
      call('remember', { sessionId: f.agent.id, callId: 'action', requestHash: 'stale' }),
    ).rejects.toThrow('changed')
    await call('remember', {
      sessionId: f.agent.id,
      callId: 'action',
      requestHash: pending.requestHash,
    })
    expect((await call('read', { sessionId: f.agent.id })).grants).toHaveLength(0)
    answer.resolve('allowed-once')
    expect((await run).isError).toBe(false)
    const saved = (await call('read', { sessionId: f.agent.id })).grants
    expect(saved).toHaveLength(1)
    expect((await call('read', { sessionId: f.agent.id })).pending).toHaveLength(0)
    expect((await f.run()).isError).toBe(false)
    expect(requests).toBe(1)
    const remove = f.ctx.tools.guard(() => 'Native sandbox denial')
    expect((await f.run()).isError).toBe(true)
    remove()
    await f.ctx.typertGateway.invoke({
      namespace: 'policyPermissions',
      method: 'revoke',
      args: { sessionId: f.agent.id, id: saved[0].id },
      peer,
    })
    answer = Promise.withResolvers()
    const again = f.run()
    await expect.poll(() => requests).toBe(2)
    const rejected = (await call('read', { sessionId: f.agent.id })).pending[0]
    await call('remember', {
      sessionId: f.agent.id,
      callId: 'action',
      requestHash: rejected.requestHash,
    })
    answer.resolve('rejected')
    expect((await again).isError).toBe(true)
    expect((await call('read', { sessionId: f.agent.id })).grants).toHaveLength(0)
  } finally {
    answer.resolve('rejected')
    await peerCtx.fiber.dispose()
    await f.ctx.fiber.dispose()
  }
})
