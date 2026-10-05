/** Process death at transaction boundaries; injection belongs only to qualification fixtures. */
import { workerData } from 'node:worker_threads'
import { encodeFrame } from '../lib/codec.js'
import { SqliteEvidenceStore } from '../lib/store.js'

const store = new SqliteEvidenceStore(workerData.path, 'workspace')
const transaction = store.db.transaction.bind(store.db)
store.db.transaction = (operation) => {
  const run = transaction((...args) => {
    const value = operation(...args)
    if (workerData.phase === 'before-commit') process.exit(92)
    return value
  })
  return (...args) => {
    const value = run(...args)
    if (workerData.phase === 'after-commit') process.exit(93)
    return value
  }
}
if (workerData.candidate)
  store.publishCompressed(workerData.candidate, encodeFrame(workerData.candidate.bytes, 'gzip'))
else store.capture({ workspaceId: 'workspace', sessionId: 'session' }, workerData.event)
