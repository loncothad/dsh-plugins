import { chmod, lstat, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { LeaseJournal } from './leases.ts'

type Methods = Pick<
  LeaseJournal,
  'submit' | 'get' | 'claim' | 'renew' | 'complete' | 'fail' | 'inspect' | 'retry' | 'reap'
>
/** A bounded worker channel; callers retain business cancellation while short SQLite operations settle. */
export class ExecutionJournal {
  private readonly worker: Worker
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private sequence = 0
  private stopped = false
  private closing: Promise<void> | undefined
  private constructor(path: string, workerUrl: URL) {
    this.worker = new Worker(workerUrl, { workerData: { path }, execArgv: [] })
    this.worker.on('message', ({ id, value, error }) => {
      const request = this.pending.get(id)
      if (!request) return
      this.pending.delete(id)
      if (error) request.reject(new Error('Execution journal operation was rejected'))
      else request.resolve(value)
    })
    const fail = () => {
      this.stopped = true
      for (const request of this.pending.values())
        request.reject(new Error('Execution journal worker stopped'))
      this.pending.clear()
    }
    this.worker.on('error', fail)
    this.worker.on('exit', fail)
  }
  static async open(path: string, options: { workerUrl?: URL } = {}): Promise<ExecutionJournal> {
    if (!isAbsolute(path)) throw new Error('Execution journal path must be absolute')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const parent = await lstat(dirname(path))
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw new Error('Execution journal directory must be a real directory')
    if (process.platform !== 'win32' && (parent.mode & 0o077) !== 0)
      throw new Error('Execution journal directory must be private (0700)')
    try {
      const file = await lstat(path)
      if (!file.isFile() || file.isSymbolicLink())
        throw new Error('Execution journal path must be a real file')
      if (process.platform !== 'win32') await chmod(path, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return new ExecutionJournal(
      path,
      options.workerUrl ?? new URL('./journal-worker.js', import.meta.url),
    )
  }
  call<K extends keyof Methods>(
    operation: K,
    ...args: Parameters<Methods[K]>
  ): Promise<ReturnType<Methods[K]>> {
    if (this.stopped || this.closing)
      return Promise.reject(new Error('Execution journal is closed'))
    if (this.pending.size >= 256)
      return Promise.reject(new Error('Execution journal channel capacity exceeded'))
    return this.send(operation, args) as Promise<ReturnType<Methods[K]>>
  }
  private send(operation: string, args: unknown[]): Promise<unknown> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.worker.postMessage({ id, operation, args })
      } catch {
        this.pending.delete(id)
        reject(new Error('Execution journal command is not serializable'))
      }
    })
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = (async () => {
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
