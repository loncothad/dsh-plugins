import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import { fingerprint } from '@loncothad/dsh-execution-core'
import { editableConfig, managedApply, registerStatus } from '@loncothad/dsh-plugin-runtime'
import { Checkpoints, createWorktree, type FileLimits, git, inside } from './files.ts'

export { Checkpoints, createWorktree } from './files.ts'
export const name = 'workspace-safety'
export const inject = [
  'agents',
  'sessions',
  'commands',
  'tools',
  'sessionProjections',
  'workspaceRegistry',
]
const schema = z.object({
  repositories: z
    .dict(z.string())
    .default({})
    .description(
      'Named absolute repository roots. Empty discovers the current host repository. Models cannot request arbitrary repositories or source paths.',
    ),
  dataDir: z
    .string()
    .description(
      'Absolute private checkpoint directory. Default: $DSH_HOME/checkpoints. It must be outside every captured workspace; model deletion of the working repository does not remove snapshots.',
    ),
  worktreeDir: z
    .string()
    .description(
      'Absolute root for isolated working trees, outside raw repositories and deployment homes. Default: a host-specific directory under the system temporary directory.',
    ),
  branchPrefix: z
    .string()
    .default('dsh')
    .description(
      'Dedicated branch prefix. Each isolated session adds the environment and a fresh unique identity; existing branches are never reset.',
    ),
  requireWorktree: z
    .boolean()
    .default(true)
    .description(
      'Prevent model tools from operating directly in configured raw repositories. Start an isolated session with the conversation button or /workspace start REPOSITORY.',
    ),
  maxFiles: z
    .number()
    .step(1)
    .min(1)
    .max(100000)
    .default(20000)
    .description('Maximum tracked and non-ignored files captured or copied.'),
  maxFileBytes: z
    .number()
    .step(1)
    .min(1024)
    .max(268435456)
    .default(16777216)
    .description('Maximum individual file bytes.'),
  maxTotalBytes: z
    .number()
    .step(1)
    .min(1024)
    .max(2147483648)
    .default(268435456)
    .description('Aggregate workspace snapshot byte limit.'),
  maxCheckpoints: z
    .number()
    .step(1)
    .min(1)
    .max(1000)
    .default(128)
    .description(
      'Retained checkpoint quota. Admission stops at this limit; snapshots are never silently deleted to make room.',
    ),
  timeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .max(300000)
    .default(60000)
    .description('Deadline for Git preparation, checkpoint capture and recovery.'),
})
export const Config = editableConfig(schema)
interface Policy extends FileLimits {
  repositories: Record<string, string>
  dataDir?: string
  worktreeDir?: string
  branchPrefix: string
  requireWorktree: boolean
  maxCheckpoints: number
}
interface Workspace {
  path: string
  branch: string
  repository: string
  sessionId: string
}
interface Gate {
  active: boolean
}
async function activate(ctx: Context, input: Partial<Policy>, gate: Gate): Promise<void> {
  const policy = schema(input) as Policy,
    home = process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    dataDir = policy.dataDir ?? join(home, 'checkpoints'),
    worktreeDir =
      policy.worktreeDir ?? join(tmpdir(), 'dsh-worktrees', fingerprint(home).slice(0, 16))
  if (
    !isAbsolute(dataDir) ||
    !isAbsolute(worktreeDir) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,127}$/.test(policy.branchPrefix)
  )
    throw new Error('Choose absolute workspace/checkpoint roots and a valid branch prefix')
  const lifetime = new AbortController(),
    owned = new Set<AgentHandle>(),
    workspaces = new Map<string, Workspace>(),
    repositories: Record<string, string> = {}
  for (const [id, path] of Object.entries(policy.repositories)) {
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(id) || !isAbsolute(path))
      throw new Error('Invalid repository mapping')
    repositories[id] = await realpath(path)
  }
  if (!Object.keys(repositories).length) {
    try {
      repositories.project = (
        await git(process.cwd(), ['rev-parse', '--show-toplevel'], lifetime.signal)
      ).trim()
    } catch {}
  }
  for (const path of Object.values(repositories))
    if (inside(path, dataDir) || inside(path, worktreeDir))
      throw new Error('Checkpoint and worktree directories must be outside raw repositories')
  const checkpoints = new Checkpoints(dataDir, policy),
    registryPath = join(dataDir, 'workspaces.json')
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  try {
    const rows = JSON.parse(await readFile(registryPath, 'utf8')) as Workspace[]
    if (!Array.isArray(rows) || rows.length > 1024) throw new Error('Invalid workspace registry')
    for (const row of rows)
      if (
        row &&
        typeof row.path === 'string' &&
        inside(worktreeDir, row.path) &&
        typeof row.sessionId === 'string'
      )
        workspaces.set(row.sessionId, row)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Workspace registry could not be read')
  }
  let writes = Promise.resolve()
  const persist = () => {
    const operation = writes.then(async () => {
      const temporary = `${registryPath}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify([...workspaces.values()], null, 2)}\n`, {
        mode: 0o600,
      })
      const { rename } = await import('node:fs/promises')
      await rename(temporary, registryPath)
    })
    writes = operation.catch(() => {})
    return operation
  }
  ctx.tools.guard((exec) => {
    if (!policy.requireWorktree || !exec.agent) return undefined
    const cwd = exec.agent.session.header.cwd
    if (!cwd) return 'A workspace is required before repository tools can execute.'
    if (
      Object.values(repositories).some((root) => inside(root, cwd)) &&
      !workspaces.has(exec.agent.id)
    )
      return JSON.stringify({
        kind: 'missing_permissions',
        code: 'ISOLATED_WORKSPACE_REQUIRED',
        message:
          'Open an isolated work session with /workspace start. Raw repository operations are blocked.',
      })
    const workspace = workspaces.get(exec.agent.id)
    if (!workspace) return undefined
    const args =
      exec.arguments && typeof exec.arguments === 'object'
        ? (exec.arguments as Record<string, unknown>)
        : {}
    for (const key of ['path', 'file_path', 'filepath', 'cwd', 'directory', 'root'])
      if (typeof args[key] === 'string') {
        let path = resolve(workspace.path, args[key] as string)
        try {
          path = realpathSync(path)
        } catch {}
        if (!inside(workspace.path, path))
          return 'This session cannot access another workspace or the raw repository.'
      }
    return undefined
  })
  ctx.commands.register({
    name: 'workspace',
    description: 'Create an isolated Git work session on a dedicated branch',
    input: { hint: 'status | start REPOSITORY' },
    handler: async (invocation) => {
      invocation.signal.throwIfAborted()
      const raw = invocation.rawInput.trim() || 'status'
      if (raw === 'status')
        return {
          kind: 'success',
          text: JSON.stringify(
            {
              repositories,
              workspace: workspaces.get(invocation.agent.id) ?? null,
              requireWorktree: policy.requireWorktree,
            },
            null,
            2,
          ),
        }
      if (!raw.startsWith('start'))
        return { kind: 'error', text: 'Use /workspace status or /workspace start REPOSITORY.' }
      const id = raw.slice(5).trim() || Object.keys(repositories)[0],
        repository = id ? repositories[id] : undefined
      if (!repository)
        return {
          kind: 'error',
          text: 'Configure a named repository in Plugins → Workspace Safety.',
        }
      if (workspaces.size >= 1024)
        return { kind: 'error', text: 'Workspace registry quota reached.' }
      const deadline = AbortSignal.any([
          invocation.signal,
          lifetime.signal,
          AbortSignal.timeout(policy.timeoutMs),
        ]),
        environment = ctx.get('environmentIsolation')?.environment ?? 'dev',
        sessionId = SessionId(randomUUID()),
        branch = `${policy.branchPrefix}/${environment}/${sessionId}`
      let stage = 'worktree preparation'
      try {
        ctx.get('environmentIsolation')?.assert()
        const path = await createWorktree(repository, worktreeDir, branch, policy, deadline),
          record: Workspace = { path, branch, repository, sessionId }
        stage = 'native workspace registration'
        const nativeWorkspace = await ctx.workspaceRegistry.create(path, branch)
        workspaces.set(sessionId, record)
        await persist()
        stage = 'model selection'
        const picked = ctx.sessionProjections.stateOf(invocation.agent.session, 'modelSelection'),
          selection =
            picked?.pending ?? picked?.lastUsed ?? invocation.agent.session.requestHeader()?.config
        stage = 'native agent creation'
        const handle = await ctx.agents.create({
          sessionId,
          meta: {
            cwd: path,
            ...(invocation.agent.session.header.agentPreset
              ? { agentPreset: invocation.agent.session.header.agentPreset }
              : {}),
          },
          agentOptions: {
            ...structuredClone(invocation.agent.options),
            ...(selection
              ? {
                  provider: selection.provider,
                  model: selection.model,
                  reasoningEffort: selection.reasoningEffort
                    ? ReasoningEffortId(selection.reasoningEffort)
                    : undefined,
                }
              : {}),
          },
          signal: deadline,
          setup: (_scope, prepared) => {
            if (selection)
              prepared.session.append('model/selection', {
                provider: selection.provider,
                model: selection.model,
                ...(selection.reasoningEffort
                  ? { reasoningEffort: selection.reasoningEffort }
                  : {}),
              })
          },
        })
        owned.add(handle)
        stage = 'model selection persistence'
        if (!(await ctx.sessions.flush(handle.agent.session)))
          throw new Error('Isolated session could not be persisted')
        stage = 'native workspace membership'
        await nativeWorkspace.attachSession(sessionId)
        return { kind: 'success', text: JSON.stringify(record) }
      } catch {
        return {
          kind: 'error',
          text: `Isolated session creation failed during ${stage}. The raw repository was preserved; inspect workspace configuration and native agent/preset availability.`,
        }
      }
    },
  })
  ctx.commands.register({
    name: 'checkpoint',
    description: 'Create, list, diff or restore external immutable workspace snapshots',
    input: { hint: 'create | list | diff ID | restore ID ABSOLUTE_EMPTY_DIRECTORY' },
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim() || 'list',
        cwd = invocation.agent.session.header.cwd,
        deadline = AbortSignal.any([
          invocation.signal,
          lifetime.signal,
          AbortSignal.timeout(policy.timeoutMs),
        ])
      try {
        if (raw === 'list')
          return { kind: 'success', text: JSON.stringify(await checkpoints.list(), null, 2) }
        if (!cwd) throw new Error('No workspace directory')
        if (raw === 'create') {
          if ((await checkpoints.list()).length >= policy.maxCheckpoints)
            throw new Error('Checkpoint quota reached')
          const value = await checkpoints.capture(cwd, deadline)
          return {
            kind: 'success',
            text: JSON.stringify({
              id: value.id,
              files: value.files.length,
              omittedCredentialFiles: value.omitted,
            }),
          }
        }
        if (raw.startsWith('diff '))
          return {
            kind: 'success',
            text: JSON.stringify(
              await checkpoints.diff(raw.slice(5).trim(), cwd, deadline),
              null,
              2,
            ),
          }
        const restore = /^restore ([a-f0-9]{64}) ([\s\S]+)$/.exec(raw)
        if (restore) {
          await checkpoints.restore(restore[1]!, restore[2]!.trim(), deadline)
          return {
            kind: 'success',
            text: `Checkpoint restored into ${restore[2]!.trim()}. Existing nonempty directories are never overwritten.`,
          }
        }
        return {
          kind: 'error',
          text: 'Use create, list, diff ID or restore ID ABSOLUTE_EMPTY_DIRECTORY.',
        }
      } catch {
        return {
          kind: 'error',
          text: 'Checkpoint operation failed validation, integrity or resource checks. The saved snapshots and existing nonempty working directories were preserved.',
        }
      }
    },
  })
  registerStatus(ctx, 'workspace', () => ({
    ready: Object.keys(repositories).length > 0,
    message: Object.keys(repositories).length
      ? 'Isolated branches and external checkpoints are configured.'
      : 'Configure a repository before starting an isolated session.',
    fields: [
      { label: 'Repositories', value: Object.keys(repositories).join(', ') || 'None' },
      { label: 'Worktree root', value: worktreeDir },
      { label: 'Checkpoint root', value: dataDir },
      {
        label: 'Raw repository tools',
        value: policy.requireWorktree ? 'Blocked' : 'Explicitly permitted',
      },
      { label: 'Restore behavior', value: 'New empty directory only; credential files omitted' },
    ],
  }))
  gate.active = true
  ctx.effect(
    () => async () => {
      gate.active = false
      lifetime.abort()
      await Promise.allSettled([...owned].map((handle) => handle.dispose()))
      await writes
      owned.clear()
    },
    'workspace-safety: stop owned sessions and retain recoverable worktrees',
  )
}
const mount = managedApply(schema, activate)
export function apply(ctx: Context, input: Parameters<typeof mount>[1]): ReturnType<typeof mount> {
  const gate: Gate = { active: false }
  ctx.tools.guard(() =>
    gate.active
      ? undefined
      : 'Workspace isolation authority is unavailable or its configuration is invalid.',
  )
  return mount(ctx, input, gate)
}
