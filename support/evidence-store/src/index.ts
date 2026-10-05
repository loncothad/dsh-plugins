/** The public boundary owns no SQLite connection; synchronous storage stays off the agent loop. */

import { dirname, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { MemoryAtom } from './memory.ts'
import type {
  CapturedEvent,
  CaptureResult,
  ColdObject,
  CompressedObject,
  ControlRecord,
  EvidenceHit,
  ExtractionDiagnostics,
  ExtractionJob,
  ExtractionPolicy,
  JobReport,
  Manifest,
  ManifestInput,
  Scope,
  SourceState,
  StoreCommand,
  StoreStatus,
} from './types.ts'

export * from './assemble.ts'
export * from './extract.ts'
export * from './memory.ts'
export * from './replay.ts'
export type * from './types.ts'

export class EvidenceStore {
  private readonly worker: Worker
  private nextId = 0
  private pendingBytes = 0
  private closed = false
  private closing: Promise<void> | undefined
  private stopping = false
  private maintenance: Promise<number> | undefined
  private archiveWorker: Worker | undefined
  private archiveDirectory: string | undefined
  private archiveUrl: URL
  private pending = new Map<
    number,
    { bytes: number; resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >()
  constructor(
    path: string,
    workspaceId: string,
    workerUrl = new URL('./worker.js', import.meta.url),
    archiveUrl = new URL('./archive-worker.js', import.meta.url),
  ) {
    this.archiveDirectory = path === ':memory:' ? undefined : resolve(dirname(path), 'objects')
    this.archiveUrl = archiveUrl
    this.worker = new Worker(workerUrl, { workerData: { path, workspaceId } })
    this.worker.on('message', (reply: { id: number; result?: unknown; error?: string }) => {
      const pending = this.pending.get(reply.id)
      if (!pending) return
      this.pending.delete(reply.id)
      this.pendingBytes -= pending.bytes
      if (reply.error) pending.reject(new Error(reply.error))
      else pending.resolve(reply.result)
    })
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', (code) => {
      if (this.pending.size || code) this.fail(new Error(`Evidence worker exited (${code})`))
      this.closed = true
    })
  }
  private fail(error: Error): void {
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.pendingBytes = 0
  }
  private request<T>(command: StoreCommand): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Evidence store is closed'))
    if (this.closing && command.op !== 'close')
      return Promise.reject(new Error('Evidence store is closing'))
    if (this.pending.size >= 64) return Promise.reject(new Error('Evidence storage queue is full'))
    let bytes: number
    try {
      bytes = Buffer.byteLength(JSON.stringify(command), 'utf8')
    } catch {
      return Promise.reject(new Error('Evidence storage commands must be serializable'))
    }
    if (bytes > 16 * 1024 * 1024 || this.pendingBytes + bytes > 32 * 1024 * 1024)
      return Promise.reject(new Error('Evidence storage byte queue is full'))
    this.pendingBytes += bytes
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { bytes, resolve: (value) => resolve(value as T), reject })
      try {
        this.worker.postMessage({ id, command })
      } catch (error) {
        this.pending.delete(id)
        this.pendingBytes -= bytes
        reject(error)
      }
    })
  }
  capture(scope: Scope, event: CapturedEvent): Promise<CaptureResult> {
    return this.request({ op: 'capture', scope, event })
  }
  search(scope: Scope, query: string, limit = 8): Promise<EvidenceHit[]> {
    return this.request({ op: 'search', scope, query, limit })
  }
  read(scope: Scope, ids: number[]): Promise<EvidenceHit[]> {
    return this.request({ op: 'read', scope, ids })
  }
  delete(scope: Scope, eventId: string): Promise<void> {
    return this.request({ op: 'delete', scope, eventId })
  }
  deleted(scope: Scope, eventIds: string[]): Promise<string[]> {
    return this.request({ op: 'deleted', scope, eventIds })
  }
  manifestAvailable(scope: Scope, id: string): Promise<boolean> {
    return this.request({ op: 'manifest-available', scope, id })
  }
  retire(before: number, protectedSessions: string[], limit = 1): Promise<number> {
    return this.request({ op: 'retire', before, protectedSessions, limit })
  }
  state(scope: Scope): Promise<SourceState> {
    return this.request({ op: 'state', scope })
  }
  seal(scope: Scope, group: string): Promise<void> {
    return this.request({ op: 'seal', scope, group })
  }
  controls(scope: Scope, expectedRevision: number, records: ControlRecord[]): Promise<SourceState> {
    return this.request({ op: 'controls', scope, expectedRevision, records })
  }
  readControls(scope: Scope, revision?: number): Promise<ControlRecord[]> {
    return this.request({ op: 'read-controls', scope, revision })
  }
  policy(scope: Scope, policy: ExtractionPolicy): Promise<SourceState> {
    return this.request({ op: 'policy', scope, policy })
  }
  pendingEvidence(scope: Scope, limit = 8): Promise<EvidenceHit[]> {
    return this.request({ op: 'pending', scope, limit })
  }
  enqueue(scope: Scope, evidenceIds: number[], sourceTokens: number): Promise<string> {
    return this.request({ op: 'enqueue', scope, evidenceIds, sourceTokens })
  }
  claim(scope: Scope): Promise<ExtractionJob | undefined> {
    return this.request({ op: 'claim', scope })
  }
  diagnostics(scope: Scope): Promise<ExtractionDiagnostics> {
    return this.request({ op: 'diagnostics', scope })
  }
  publish(
    scope: Scope,
    job: ExtractionJob,
    payload: unknown,
    report: JobReport,
  ): Promise<string[]> {
    return this.request({ op: 'publish', scope, job, payload, report })
  }
  gap(scope: Scope, job: ExtractionJob, report: JobReport, retry = false): Promise<void> {
    return this.request({ op: 'gap', scope, job, report, retry })
  }
  atoms(scope: Scope, limit = 48): Promise<MemoryAtom[]> {
    return this.request({ op: 'atoms', scope, limit })
  }
  manifest(scope: Scope, input: ManifestInput): Promise<Manifest> {
    return this.request({ op: 'manifest', scope, input })
  }
  replay(scope: Scope, id: string): Promise<Manifest> {
    return this.request({ op: 'replay', scope, id })
  }
  replayRequest(scope: Scope, id: string): Promise<unknown> {
    return this.request({ op: 'replay-request', scope, id })
  }
  /** At most one compression operation; foreground requests pause maintenance between objects. */
  maintain(
    signal: AbortSignal,
    options: { now?: number; codec?: 'gzip' | 'zstd'; objects?: number } = {},
  ): Promise<number> {
    if (this.maintenance) return this.maintenance
    const limit = options.objects ?? 8
    if (!Number.isInteger(limit) || limit < 1 || limit > 8)
      return Promise.reject(new Error('Invalid maintenance object budget'))
    const operation = async () => {
      let archived = 0
      signal.throwIfAborted()
      if (!this.stopping && !this.pending.size)
        await this.request<number>({ op: 'cleanup-orphans', now: Date.now(), limit: 32 })
      for (
        let count = 0;
        count < limit && !this.stopping && !this.closed && !this.pending.size;
        count++
      ) {
        signal.throwIfAborted()
        const rows = await this.request<ColdObject[]>({
          op: 'cold',
          now: options.now ?? Date.now(),
          limit: 1,
        })
        const candidate = rows[0]
        if (!candidate) break
        const encoded = await this.compress(candidate, options.codec ?? 'zstd')
        signal.throwIfAborted()
        if (this.stopping || !encoded) break
        if (await this.request<boolean>({ op: 'compressed', candidate, encoded })) archived++
      }
      return archived
    }
    this.maintenance = operation().finally(() => {
      this.maintenance = undefined
    })
    return this.maintenance
  }
  private compress(
    candidate: ColdObject,
    preferred: 'gzip' | 'zstd',
  ): Promise<CompressedObject | undefined> {
    this.archiveWorker ??= new Worker(this.archiveUrl)
    const worker = this.archiveWorker
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        worker.off('message', message)
        worker.off('error', failed)
        worker.off('exit', exited)
      }
      const message = (reply: { result?: CompressedObject; error?: string }) => {
        cleanup()
        if (reply.error) reject(new Error(reply.error))
        else resolve(reply.result)
      }
      const failed = (error: Error) => {
        cleanup()
        this.archiveWorker = undefined
        reject(error)
      }
      const exited = (code: number) => failed(new Error(`Compression worker exited (${code})`))
      worker.once('message', message)
      worker.once('error', failed)
      worker.once('exit', exited)
      worker.postMessage({ id: 1, candidate, preferred, directory: this.archiveDirectory })
    })
  }
  status(): Promise<StoreStatus> {
    return this.request({ op: 'status' })
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    if (this.closed) return Promise.resolve()
    this.stopping = true
    this.closing = (async () => {
      await this.maintenance?.catch(() => {})
      await this.request<void>({ op: 'close' })
      this.closed = true
      await Promise.all([this.worker.terminate(), this.archiveWorker?.terminate()])
    })()
    return this.closing
  }
}
