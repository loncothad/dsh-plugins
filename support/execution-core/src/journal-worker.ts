import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { LeaseJournal } from './leases.ts'

if (!parentPort) throw new Error('Execution journal must run in its worker')
const db = new Database(String(workerData.path))
db.pragma('journal_mode=WAL')
db.pragma('synchronous=FULL')
db.pragma('busy_timeout=5000')
const journal = new LeaseJournal(db)
parentPort.on(
  'message',
  ({
    id,
    operation,
    args,
  }: {
    id: number
    operation:
      | 'submit'
      | 'get'
      | 'claim'
      | 'renew'
      | 'complete'
      | 'fail'
      | 'inspect'
      | 'retry'
      | 'reap'
      | 'close'
    args: unknown[]
  }) => {
    try {
      if (!Number.isSafeInteger(id) || !Array.isArray(args) || args.length > 8)
        throw new Error('Invalid journal command')
      let value: unknown
      if (operation === 'close') {
        db.close()
        value = null
      } else {
        const method = journal[operation]
        if (typeof method !== 'function') throw new Error('Unknown journal command')
        value = Reflect.apply(method, journal, args)
      }
      parentPort!.postMessage({ id, value })
      if (operation === 'close') parentPort!.close()
    } catch {
      parentPort!.postMessage({ id, error: 'Execution journal operation was rejected' })
    }
  },
)
