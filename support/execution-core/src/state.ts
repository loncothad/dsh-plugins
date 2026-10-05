import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { Worker } from 'node:worker_threads'
export interface PrivateSnapshot<T = unknown> {
  revision: number
  anchor: number
  observedAt: number
  value: T
}
export class PrivateStateJournal {
  private readonly worker: Worker
  private sequence = 0
  private stopped = false
  private closing: Promise<void> | undefined
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private constructor(path: string, workerUrl: URL) {
    this.worker = new Worker(workerUrl, { workerData: { path }, execArgv: [] })
    this.worker.on('message', ({ id, value, error }) => {
      const row = this.pending.get(id)
      if (!row) return
      this.pending.delete(id)
      if (error) row.reject(new Error('Private plugin state operation was rejected'))
      else row.resolve(value)
    })
    const fail = () => {
      this.stopped = true
      for (const row of this.pending.values())
        row.reject(new Error('Private plugin state worker stopped'))
      this.pending.clear()
    }
    this.worker.on('error', fail)
    this.worker.on('exit', fail)
  }
  static async open(
    path: string,
    workerUrl = existsSync(new URL('./state-worker.js', import.meta.url))
      ? new URL('./state-worker.js', import.meta.url)
      : new URL('../lib/state-worker.js', import.meta.url),
  ): Promise<PrivateStateJournal> {
    if (!isAbsolute(path)) throw new Error('Private state path must be absolute')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const parent = await lstat(dirname(path))
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (process.platform !== 'win32' && (parent.mode & 0o077) !== 0)
    )
      throw new Error('Private state directory is unsafe')
    try {
      const file = await lstat(path)
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('Private state file is unsafe')
      if (process.platform !== 'win32') await chmod(path, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return new PrivateStateJournal(path, workerUrl)
  }
  private send(operation: string, args: unknown[]): Promise<unknown> {
    if (this.stopped || this.pending.size >= 256)
      return Promise.reject(new Error('Private state channel is unavailable'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.worker.postMessage({ id, operation, args })
      } catch {
        this.pending.delete(id)
        reject(new Error('Private state is not serializable'))
      }
    })
  }
  read<T>(
    scope: string,
    anchor = Number.MAX_SAFE_INTEGER,
    before = Number.MAX_SAFE_INTEGER,
  ): Promise<PrivateSnapshot<T> | null> {
    if (this.closing) throw new Error('Private state is closing')
    return this.send('read', [scope, anchor, before]) as Promise<PrivateSnapshot<T> | null>
  }
  write<T>(scope: string, expected: number, anchor: number, value: T): Promise<PrivateSnapshot<T>> {
    if (this.closing) throw new Error('Private state is closing')
    return this.send('write', [scope, expected, anchor, value]) as Promise<PrivateSnapshot<T>>
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      if (!this.stopped) {
        try {
          await this.send('close', [])
        } finally {
          this.stopped = true
          await this.worker.terminate()
        }
      }
    })()
    return this.closing
  }
}
