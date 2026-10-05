import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import {
  fingerprint,
  type PrivateSnapshot,
  PrivateStateJournal,
} from '@loncothad/dsh-execution-core'
import { privateStateContribution } from './private-state-wire.ts'

const registries = new WeakMap<Context, Map<string, (sessionId: string) => Promise<unknown>>>()
export function registerPrivateStateReader(
  ctx: Context,
  channel: string,
  read: (sessionId: string) => Promise<unknown>,
): void {
  const root = ctx.root
  let readers = registries.get(root)
  if (!readers) {
    readers = new Map()
    registries.set(root, readers)
  }
  if (readers.has(channel)) throw new Error('Private state channel already registered')
  readers.set(channel, read)
  ctx.inject(['typert'], (scope) => {
    const contribution = privateStateContribution(channel),
      namespace = `pluginState_${channel}`
    class State extends TypertRemoteService {
      constructor() {
        super(scope, namespace)
        scope.typert.register({
          package: contribution.package,
          face: 'host',
          model: { services: [], events: [], objects: [] },
          schemas: [],
          invocations: contribution.descriptors,
        })
      }
      async read(sessionId: string): Promise<string> {
        if (!this.ctx.invocation)
          throw new Error('Private UI state requires the authenticated human Gateway')
        const value = JSON.stringify(await read(sessionId))
        if (value.length > 131072) throw new Error('Private UI state exceeds its bound')
        return value
      }
    }
    new State()
  })
  ctx.effect(
    () => () => {
      if (readers!.get(channel) === read) readers!.delete(channel)
    },
    'private state: withdraw human reader',
  )
}
/** Private snapshots preserve plugin authority without unsupported upstream log records. */
export class PluginState<T> {
  private readonly rows = new Map<string, PrivateSnapshot<T>>()
  private readonly loads = new Map<string, Promise<T>>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private failed = false
  private constructor(
    private readonly ctx: Context,
    private readonly directory: string,
    private readonly channel: string,
    private readonly journal: PrivateStateJournal,
    private readonly initial: () => T,
    private readonly parse: (value: unknown) => T,
  ) {}
  static async open<T>(
    ctx: Context,
    channel: string,
    initial: () => T,
    parse: (value: unknown) => T,
    options: { workerUrl?: URL; directory?: string } = {},
  ): Promise<PluginState<T>> {
    if (!/^[a-z][a-zA-Z0-9-]{0,63}$/.test(channel)) throw new Error('Invalid plugin state channel')
    const journal = await PrivateStateJournal.open(
      join(
        options.directory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-state'),
        `${channel}.sqlite`,
      ),
      options.workerUrl,
    )
    const directory = await realpath(
        options.directory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-state'),
      ),
      store = new PluginState(ctx, directory, channel, journal, initial, parse)
    ctx.effect(() => () => store.close(), 'private state: drain snapshot writes and close worker')
    return store
  }
  private scope(id: string): string {
    return fingerprint({ home: process.env.DSH_HOME ?? homedir(), channel: this.channel, id })
  }
  private async validate(session: Session): Promise<void> {
    const boundary = this.ctx.get('environmentIsolation')
    boundary?.assert()
    if (boundary) {
      const delta = relative(process.env.DSH_HOME ?? join(homedir(), '.dsh'), this.directory)
      if (delta.startsWith('..') || isAbsolute(delta))
        throw new Error('Private state must stay inside its deployment home')
    }
    if (session.header.cwd) {
      const cwd = await realpath(session.header.cwd),
        delta = relative(cwd, this.directory)
      if (delta === '' || (!delta.startsWith('..') && !isAbsolute(delta)))
        throw new Error('Private state must be outside agent workspaces')
    }
  }
  async ensure(session: Session): Promise<T> {
    await this.validate(session)
    if (this.failed) throw new Error('Private state persistence is unavailable')
    const known = this.rows.get(session.id)
    if (known) return known.value
    const loading = this.loads.get(session.id)
    if (loading) return loading
    if (this.rows.size + this.loads.size >= 1024)
      throw new Error('Private state session capacity reached')
    const pending = (async () => {
      let row = await this.journal.read<T>(this.scope(session.id))
      if (!row && session.header.isSeeded && session.header.parentSession) {
        const time = session.header.createdAt
        if (!Number.isSafeInteger(time)) throw new Error('Fork timestamp unavailable')
        const inherited = await this.journal.read<T>(
          this.scope(session.header.parentSession),
          Number(session.inheritedEventCount) - 1,
          time,
        )
        if (inherited)
          row = await this.journal.write(
            this.scope(session.id),
            0,
            Number(session.inheritedEventCount) - 1,
            this.parse(inherited.value),
          )
      }
      const result = row
        ? { ...row, value: this.parse(row.value) }
        : { revision: 0, anchor: -1, observedAt: 0, value: this.initial() }
      this.rows.set(session.id, result)
      return result.value
    })().finally(() => this.loads.delete(session.id))
    this.loads.set(session.id, pending)
    return pending
  }
  get(session: Session): T {
    if (this.failed) throw new Error('Private state persistence is unavailable')
    const row = this.rows.get(session.id)
    if (!row) throw new Error('Private state has not been restored')
    return row.value
  }
  async update(session: Session, apply: (value: T) => T): Promise<T> {
    const prior = this.queues.get(session.id) ?? Promise.resolve()
    const operation = prior.then(async () => {
      await this.ensure(session)
      const row = this.rows.get(session.id)!,
        value = this.parse(apply(row.value))
      try {
        const saved = await this.journal.write(
          this.scope(session.id),
          row.revision,
          Number(session.snapshotEvents().at(-1)?.seq ?? -1),
          value,
        )
        this.rows.set(session.id, saved)
        return saved.value
      } catch (error) {
        this.failed = true
        throw error
      }
    })
    this.queues.set(session.id, operation)
    try {
      return await operation
    } finally {
      if (this.queues.get(session.id) === operation) this.queues.delete(session.id)
    }
  }
  async read(session: Session): Promise<T> {
    await this.queues.get(session.id)
    return this.ensure(session)
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.loads.values(), ...this.queues.values()])
    this.rows.clear()
    await this.journal.close()
  }
}
/** Trusted host consumers may inspect metadata; no raw external-summary content reader is registered here. */
export async function readPrivateState<T>(
  ctx: Context,
  sessionId: string,
  channel: string,
): Promise<T> {
  const reader = registries.get(ctx.root)?.get(channel)
  if (!reader) throw new Error('Private plugin state is unavailable')
  return (await reader(sessionId)) as T
}
