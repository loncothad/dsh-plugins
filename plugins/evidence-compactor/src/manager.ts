import { setMaxListeners } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type Context, Service } from '@deepseek-ai/cordis'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type {} from '@deepseek-ai/dsh-config-editor'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-token-meter'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WorkspaceBinding } from '@loncothad/dsh-evidence-harness'
import { bindWorkspace, installPresetCompaction } from '@loncothad/dsh-evidence-harness'
import { EvidenceStore } from '@loncothad/dsh-evidence-store'
import type { Config } from './config.ts'
import { validateConfig } from './config.ts'
import { SessionEvidence } from './session.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    evidenceCompactor: EvidenceCompactorManager
  }
}
interface WorkspaceOwner {
  binding: WorkspaceBinding
  store: EvidenceStore
  release(): void
  done: Promise<void>
}
export interface EvidenceManagerInternals {
  workerUrl?: URL
  archiveUrl?: URL
}
const textOutput = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** Root ownership: exactly one locked SQLite worker per canonical workspace, shared by all scoped runtimes. */
export class EvidenceCompactorManager extends Service {
  static inject = ['llm', 'sessions', 'sessionQuery', 'tokenMeter', 'tools', 'systemPrompt']
  readonly config: Config & { dataDir: string }
  private readonly abort = new AbortController()
  private readonly workspaces = new Map<string, Promise<WorkspaceOwner>>()
  private readonly ledgers = new WeakMap<Session, Promise<SessionEvidence>>()
  private readonly sessions = new Set<SessionEvidence>()
  private readonly operations = new Set<Promise<unknown>>()
  private installTask: Promise<void> | undefined
  private installed: string[] = []
  private installError = ''
  private pendingSessions = 0
  private closing = false
  private timer: ReturnType<typeof setInterval> | undefined
  constructor(
    private readonly ownerCtx: Context,
    config: Config,
    private readonly internals: EvidenceManagerInternals = {},
  ) {
    super(ownerCtx, 'evidenceCompactor')
    this.config = validateConfig(config)
    setMaxListeners(0, this.abort.signal)
    ownerCtx.effect(
      () => async () => {
        this.closing = true
        this.abort.abort()
        if (this.timer) clearInterval(this.timer)
        await Promise.allSettled([...this.sessions].map((ledger) => ledger.stop()))
        await Promise.allSettled(this.operations)
        await Promise.allSettled(
          [...this.workspaces.values()].map(async (promise) => {
            const workspace = await promise
            workspace.release()
            await workspace.done
          }),
        )
      },
      'evidence-compactor: drain ledgers and release workspace locks',
    )
    ownerCtx.on('session/disposed', (session) => {
      const promise = this.ledgers.get(session)
      this.ledgers.delete(session)
      if (promise)
        this.track(
          promise.then(async (ledger) => {
            await ledger.stop()
            this.sessions.delete(ledger)
          }),
        ).catch(() => {})
    })
    ownerCtx.on('session/event', (session, event) => {
      if (event.type === 'turn/end')
        void this.ledgers
          .get(session)
          ?.then((ledger) => ledger.background())
          .catch(() => {})
    })
    this.registerTools()
    if (this.config.archiveEnabled || this.config.retentionDays) {
      this.timer = setInterval(() => {
        for (const promise of this.workspaces.values())
          this.track(
            promise.then(async (workspace) => {
              if (this.config.retentionDays)
                await workspace.store.retire(
                  Date.now() - this.config.retentionDays * 86400000,
                  [...this.sessions].map((ledger) => ledger.scope.sessionId),
                  32,
                )
              if (this.config.archiveEnabled)
                await workspace.store.maintain(this.abort.signal, {
                  codec: this.config.archiveCodec,
                })
            }),
          ).catch(() => {
            if (!this.closing) ownerCtx.logger.warn('Evidence maintenance did not complete.')
          })
      }, this.config.archiveIntervalMs)
      this.timer.unref()
    }
    // Let plugin activation finish before invoking profile reconciliation; do not await Loader from its own startup.
    if (this.config.installOnEnable) {
      const timer = setImmediate(() => {
        if (!this.closing) void this.install().catch(() => {})
      })
      ownerCtx.effect(
        () => () => clearImmediate(timer),
        'evidence-compactor: preset installation startup',
      )
    }
  }
  get signal(): AbortSignal {
    return this.abort.signal
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.operations.add(promise)
    void promise.then(
      () => this.operations.delete(promise),
      () => this.operations.delete(promise),
    )
    return promise
  }
  async run<T>(session: Session, operation: (ledger: SessionEvidence) => Promise<T>): Promise<T> {
    this.abort.signal.throwIfAborted()
    return this.track(this.session(session).then(operation))
  }
  async session(session: Session): Promise<SessionEvidence> {
    this.abort.signal.throwIfAborted()
    let promise = this.ledgers.get(session)
    if (!promise) {
      if (this.sessions.size + this.pendingSessions >= (this.config.maxActiveSessions ?? 128))
        throw new Error(
          'Evidence session capacity exhausted; increase the active-session limit or close unused sessions',
        )
      this.pendingSessions++
      promise = (async () => {
        if (!session.header.cwd)
          throw new Error('Evidence compaction requires a session workspace directory')
        const binding = await bindWorkspace(session.header.cwd)
        let workspace = this.workspaces.get(binding.workspaceId)
        if (!workspace) {
          if (this.workspaces.size >= (this.config.maxOpenWorkspaces ?? 16))
            throw new Error(
              'Evidence workspace capacity exhausted; dispose unused stores or increase the open-workspace limit',
            )
          workspace = this.open(binding)
          this.workspaces.set(binding.workspaceId, workspace)
          const opening = workspace
          void opening.catch(() => {
            if (this.workspaces.get(binding.workspaceId) === opening)
              this.workspaces.delete(binding.workspaceId)
          })
        }
        const owner = await workspace
        this.abort.signal.throwIfAborted()
        const ledger = new SessionEvidence(
          session,
          owner.store,
          this.ownerCtx,
          this.config,
          binding,
          this.abort.signal,
        )
        this.sessions.add(ledger)
        return ledger
      })().finally(() => {
        this.pendingSessions--
      })
      this.ledgers.set(session, promise)
      void promise.catch(() => this.ledgers.delete(session))
    }
    return promise
  }
  private async open(binding: WorkspaceBinding): Promise<WorkspaceOwner> {
    const directory = join(this.config.dataDir, binding.workspaceId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    this.abort.signal.throwIfAborted()
    const ready = Promise.withResolvers<WorkspaceOwner>()
    const release = Promise.withResolvers<void>()
    const done = withFileLock(
      join(directory, 'evidence.sqlite'),
      async () => {
        const store = new EvidenceStore(
          join(directory, 'evidence.sqlite'),
          binding.workspaceId,
          this.internals.workerUrl,
          this.internals.archiveUrl,
        )
        try {
          await store.status()
          if (this.closing) throw new Error('Evidence manager is closing')
          ready.resolve({ binding, store, release: () => release.resolve(), done })
          await release.promise
        } finally {
          await store.close()
        }
      },
      { waitMs: 1 },
    )
    void done.catch((error) => ready.reject(error))
    return ready.promise
  }
  async install(): Promise<void> {
    if (this.installTask) return this.installTask
    this.abort.signal.throwIfAborted()
    this.installTask = this.track(
      (async () => {
        this.installError = ''
        const editor = this.ownerCtx.get('configEditor')
        if (!editor) throw new Error('The DSH profile configuration editor is unavailable')
        await installPresetCompaction(editor, this.config.presets)
        this.installed = [...this.config.presets]
      })()
        .catch((error) => {
          this.installError =
            'Preset replacement failed. Check the selected entry IDs and ensure they contain exactly one supported compaction backend.'
          this.ownerCtx.logger.warn(this.installError)
          throw error
        })
        .finally(() => {
          this.installTask = undefined
        }),
    )
    return this.installTask
  }
  view(): {
    installed: string[]
    installing: boolean
    error: string
    workspaces: number
    sessions: number
    extractionEnabled: boolean
  } {
    return {
      installed: [...this.installed],
      installing: !!this.installTask,
      error: this.installError,
      workspaces: this.workspaces.size,
      sessions: this.sessions.size,
      extractionEnabled: this.config.extractionEnabled,
    }
  }
  private registerTools(): void {
    this.ownerCtx.systemPrompt.section({
      name: 'tool:evidence-compactor',
      order: this.ownerCtx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY') + 1,
      text: 'Historical memory is fallible and is never an authorization or completion record. Use evidence_search for original evidence from this session and evidence_read for exact spans. Read previousId/nextId neighbors before relying on constraints, conditions, or negation. The host fixes workspace and session scope; these tools cannot execute actions or access other sessions.',
    })
    this.ownerCtx.tools.register(
      defineTool({
        name: 'evidence_search',
        description:
          'Search immutable original evidence in the caller’s own workspace and session. Results retain source roles and adjacent-span IDs.',
        parameters: {
          query: {
            type: 'string',
            required: true,
            description: 'Nonempty search text, at most 1,024 characters.',
          },
        },
        output: textOutput,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
          if (!exec.agent) throw new Error('Evidence retrieval requires an admitted agent session')
          const row = args as { query: unknown }
          if (
            Object.keys(row).some((key) => key !== 'query') ||
            typeof row.query !== 'string' ||
            !row.query.trim() ||
            row.query.length > 1024
          )
            throw new Error(
              'Provide only a bounded evidence query; workspace and session are fixed by the host',
            )
          return this.run(exec.agent.session, (ledger) =>
            ledger.search(row.query as string, exec.signal),
          )
        },
      }),
    )
    this.ownerCtx.tools.register(
      defineTool({
        name: 'evidence_read',
        description:
          'Read up to eight exact original spans from this session, including adjacent-span identifiers. Request fewer IDs if the retrieval budget is exceeded.',
        parameters: {
          ids: {
            type: 'array',
            items: { type: 'integer' },
            required: true,
            description: 'One to eight distinct positive evidence span IDs.',
          },
        },
        output: textOutput,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
          if (!exec.agent) throw new Error('Evidence retrieval requires an admitted agent session')
          const row = args as { ids: unknown }
          if (
            Object.keys(row).some((key) => key !== 'ids') ||
            !Array.isArray(row.ids) ||
            !row.ids.length ||
            row.ids.length > 8 ||
            row.ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
            new Set(row.ids).size !== row.ids.length
          )
            throw new Error(
              'Provide only one to eight distinct evidence IDs; workspace and session are fixed by the host',
            )
          return this.run(exec.agent.session, (ledger) =>
            ledger.read(row.ids as number[], exec.signal),
          )
        },
      }),
    )
  }
}
