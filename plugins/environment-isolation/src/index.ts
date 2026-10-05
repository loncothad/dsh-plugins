import { realpathSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  type Environment,
  type EnvironmentAuthority,
  fingerprint,
  resolveConfiguration,
} from '@loncothad/dsh-execution-core'
import {
  abortable,
  editableConfig,
  managedApply,
  registerStatus,
} from '@loncothad/dsh-plugin-runtime'
import { inside, inspectBoundary } from './boundary.ts'
import { layerSchema, schema } from './config.ts'

export { inspectBoundary } from './boundary.ts'
export const name = 'environment-isolation'
export const inject = ['tools', 'llm', 'agents', 'commands', 'sessions']
export const Config = editableConfig(schema)
type Policy = {
  environment: Environment
  rootDirectory?: string
  allowShell: boolean
  defaults: Record<string, unknown>
  environmentOverrides: Record<string, Record<string, unknown>>
  userOverrides: Record<string, unknown>
}
const runKeys = ['maxModelCalls', 'maxToolCalls', 'maxOutputCharacters', 'timeoutMs'] as const
function match(pattern: string, name: string): boolean {
  if (!/^[a-zA-Z0-9_.*:-]{1,128}$/.test(pattern))
    throw new Error('Invalid environment tool pattern')
  return new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  ).test(name)
}
function paths(value: unknown, depth = 0): string[] {
  if (depth > 8) throw new Error('Tool argument nesting exceeds environment admission')
  if (!value || typeof value !== 'object') return []
  const result: string[] = []
  for (const [key, entry] of Object.entries(value)) {
    if (
      ['path', 'file_path', 'filepath', 'cwd', 'directory', 'root'].includes(key) &&
      typeof entry === 'string'
    )
      result.push(entry)
    else if (entry && typeof entry === 'object') result.push(...paths(entry, depth + 1))
    if (result.length > 64) throw new Error('Too many file paths for environment admission')
  }
  return result
}
interface Gate {
  current?: EnvironmentAuthority
  status?: () => { ready: boolean; message: string; fields: { label: string; value: string }[] }
}
async function activate(ctx: Context, input: Partial<Policy>, gate: Gate): Promise<void> {
  const policy = schema(input) as Policy,
    hostHome = process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    root = policy.rootDirectory?.trim() || dirname(hostHome)
  if (
    Object.keys(policy.environmentOverrides).some(
      (key) => !['dev', 'staging', 'prod'].includes(key),
    )
  )
    throw new Error('Unknown environment override')
  const proof = await inspectBoundary(root, policy.environment, hostHome),
    lifetime = new AbortController(),
    runs = new Map<string, { overrides: Record<string, unknown>; models: number; tools: number }>()
  const state = (id: string) => {
    let value = runs.get(id)
    if (!value) {
      if (runs.size >= 1024) throw new Error('Environment run capacity exceeded')
      value = { overrides: {}, models: 0, tools: 0 }
      runs.set(id, value)
    }
    return value
  }
  const effective = (id: string) =>
    resolveConfiguration(
      {
        defaults: policy.defaults,
        environment: policy.environmentOverrides[policy.environment],
        user: policy.userOverrides,
        run: state(id).overrides,
      },
      {
        keys: Object.keys(layerSchema.shape),
        runKeys,
        validate: (value) => layerSchema.parse(value),
      },
    )
  effective('configuration-check')
  runs.delete('configuration-check')
  const service: EnvironmentAuthority = {
    identity: fingerprint({ environment: policy.environment, home: proof.home, policy }),
    environment: policy.environment,
    valid: proof.valid,
    reason: proof.reason,
    scope: (id) => `${policy.environment}/${fingerprint(id)}`,
    assert() {
      if (!proof.valid || lifetime.signal.aborted) throw new Error(proof.reason)
    },
  }
  gate.status = () => ({
    ready: proof.valid,
    message: proof.reason,
    fields: [
      { label: 'Environment', value: policy.environment },
      { label: 'Host home', value: proof.home },
      {
        label: 'Sibling deployments',
        value: 'Independent dev / staging / prod homes; no credential fallback',
      },
      {
        label: 'Configuration precedence',
        value: 'defaults → environment → user/profile → admitted run overrides',
      },
      {
        label: 'Generic shell',
        value: policy.allowShell ? 'Enabled; OS sandbox and policy rules required' : 'Disabled',
      },
    ],
  })
  const protectedNames = new Set([
    '.env',
    '.env.local',
    '.credentials.yaml',
    '.npmrc',
    'id_rsa',
    'id_ed25519',
  ])
  ctx.tools.guard((exec) => {
    if (!proof.valid)
      return JSON.stringify({
        kind: 'missing_permissions',
        code: 'ENVIRONMENT_BOUNDARY',
        message: proof.reason,
      })
    if (!exec.agent) return 'Environment isolation requires a live session.'
    if (exec.agent.session.header.cwd && inside(exec.agent.session.header.cwd, proof.home))
      return 'Deployment homes must be outside agent workspaces. Open a workspace that cannot contain this host’s credentials and data.'
    const config = effective(exec.agent.id).value
    if (
      !policy.allowShell &&
      (/terminal|shell/.test(exec.name) ||
        /^(bash|exec|run_command|execute_command|run_code|write_stdin)$/.test(exec.name))
    )
      return 'Generic shell/code access is disabled in this environment. Use trusted workflow verifiers or explicitly configure the execution boundary.'
    if (!config.allowedTools.some((pattern) => match(pattern, exec.name)))
      return `Tool ${exec.name} is not admitted in ${policy.environment}.`
    if (state(exec.agent.id).tools >= config.maxToolCalls)
      return 'This run has reached its environment tool-call limit.'
    try {
      for (const value of paths(exec.arguments)) {
        const path = resolve(exec.agent.session.header.cwd ?? process.cwd(), value)
        let actual = path
        try {
          actual = realpathSync(path)
        } catch {}
        if (
          inside(proof.root, actual) ||
          inside(actual, proof.root) ||
          protectedNames.has(basename(actual))
        )
          return 'Model tools cannot access deployment homes, their containing directories or credential files.'
      }
    } catch {
      return 'Tool file paths could not be safely admitted.'
    }
    state(exec.agent.id).tools++
    return undefined
  })
  ctx.on('llm/stream', async function* (options, next) {
    service.assert()
    const id = options.sessionId ?? 'auxiliary',
      run = state(id),
      config = effective(id).value
    if (run.models >= config.maxModelCalls)
      throw new LlmError('Environment model-call limit reached', 'ENVIRONMENT_LIMIT')
    run.models++
    const deadline = AbortSignal.any([
      lifetime.signal,
      options.signal ?? new AbortController().signal,
      AbortSignal.timeout(config.timeoutMs),
    ])
    const iterator = next()[Symbol.asyncIterator](),
      deltas = new Set<number>()
    let characters = 0
    try {
      while (true) {
        const item = await abortable(Promise.resolve(iterator.next()), deadline)
        if (item.done) return
        const chunk = item.value
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          characters += chunk.text.length
          deltas.add(chunk.index)
        } else if (
          chunk.type === 'block-end' &&
          !deltas.has(chunk.index) &&
          (chunk.block.type === 'text' || chunk.block.type === 'reasoning')
        )
          characters += chunk.block.text.length
        if (characters > config.maxOutputCharacters)
          throw new LlmError('Environment output-character limit reached', 'ENVIRONMENT_LIMIT')
        yield chunk
      }
    } finally {
      if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {})
    }
  })
  ctx.commands.register({
    name: 'environment',
    description: 'Inspect environment provenance, prepare separate homes or lower run limits',
    input: { hint: 'status | prepare dev/staging/prod | limit KEY VALUE' },
    handler: async (invocation) => {
      invocation.signal.throwIfAborted()
      const raw = invocation.rawInput.trim() || 'status'
      if (raw === 'status')
        return {
          kind: 'success',
          text: JSON.stringify(
            {
              environment: policy.environment,
              valid: proof.valid,
              reason: proof.reason,
              ...effective(invocation.agent.id),
            },
            null,
            2,
          ),
        }
      if (raw.startsWith('prepare ')) {
        const name = raw.slice(8)
        if (!['dev', 'staging', 'prod'].includes(name) || !isAbsolute(root))
          return {
            kind: 'error',
            text: 'Choose dev, staging or prod beneath an absolute environment root.',
          }
        await mkdir(join(root, name), { recursive: true, mode: 0o700 })
        await realpath(join(root, name))
        return {
          kind: 'success',
          text: `Prepared ${join(root, name)} without copying credentials, data or profile settings. Start a separate DSH host with that DSH_HOME.`,
        }
      }
      const match = /^limit (\w+) (\d+)$/.exec(raw)
      if (!match || !runKeys.includes(match[1] as (typeof runKeys)[number]))
        return {
          kind: 'error',
          text: 'Use status, prepare ENV, or limit maxModelCalls/maxToolCalls/maxOutputCharacters/timeoutMs VALUE.',
        }
      const key = match[1] as (typeof runKeys)[number],
        value = Number(match[2]),
        current = effective(invocation.agent.id).value
      if (!Number.isSafeInteger(value) || value < 1 || value > current[key])
        return { kind: 'error', text: 'Per-run overrides may lower the current limit only.' }
      const next = { ...state(invocation.agent.id).overrides, [key]: value }
      try {
        layerSchema.parse({ ...current, ...next })
      } catch {
        return { kind: 'error', text: 'The limit is outside its valid range.' }
      }
      state(invocation.agent.id).overrides = next
      return { kind: 'success', text: `Run limit ${key} is now ${value}.` }
    },
  })
  const owned = new Map<Agent, Fiber>()
  const attach = (agent: Agent) => {
    if (owned.has(agent)) return
    owned.set(
      agent,
      agent.ctx.plugin({
        inject: ['systemPrompt'],
        apply(scope: Context) {
          scope.systemPrompt.section({
            name: 'environment-isolation:identity',
            order: 2440,
            interpolate: false,
            text: () => {
              const config = effective(agent.id)
              return `Deployment environment: ${policy.environment}. ${proof.valid ? 'Independent host home verified.' : 'Execution is blocked until the host home matches this environment.'}\n${config.value.guidance}\nConfiguration fingerprint: ${config.fingerprint}. Limits and permissions are enforced outside these instructions.`
            },
          })
        },
      }),
    )
  }
  for (const agent of ctx.agents.list()) attach(agent)
  ctx.on('agent/created', ({ agent }) => {
    attach(agent)
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => {
    runs.delete(agent.id)
    owned.delete(agent)
  })
  gate.current = service
  ctx.effect(
    () => async () => {
      if (gate.current === service) {
        gate.current = undefined
        gate.status = undefined
      }
      lifetime.abort()
      await Promise.allSettled([...owned.values()].map((fiber) => fiber.dispose()))
      owned.clear()
      runs.clear()
    },
    'environment-isolation: cancel scopes and release deployment identity',
  )
}
const mount = managedApply(schema, activate)
/** The outer denial survives failed activation and the gap between configuration generations. */
export function apply(ctx: Context, input: Parameters<typeof mount>[1]): ReturnType<typeof mount> {
  const gate: Gate = {}
  const proxy: EnvironmentAuthority = {
    get identity() {
      return gate.current?.identity ?? 'unavailable'
    },
    get environment() {
      return gate.current?.environment ?? 'dev'
    },
    get valid() {
      return gate.current?.valid ?? false
    },
    get reason() {
      return (
        gate.current?.reason ??
        'Environment authority is unavailable or its configuration is invalid.'
      )
    },
    scope: (id) => {
      proxy.assert()
      return gate.current!.scope(id)
    },
    assert() {
      if (!gate.current) throw new Error(proxy.reason)
      gate.current.assert()
    },
  }
  ctx.provide('environmentIsolation', proxy)
  ctx.tools.guard(() =>
    proxy.valid
      ? undefined
      : JSON.stringify({
          kind: 'missing_permissions',
          code: 'ENVIRONMENT_AUTHORITY_UNAVAILABLE',
          message: proxy.reason,
        }),
  )
  ctx.on('llm/stream', (options, next) => {
    proxy.assert()
    void options
    return next()
  })
  registerStatus(
    ctx,
    'environment',
    () => gate.status?.() ?? { ready: false, message: proxy.reason, fields: [] },
  )
  return mount(ctx, input, gate)
}
