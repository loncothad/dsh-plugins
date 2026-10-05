/** Test-only archive process death after a selected durability barrier. */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { workerData } from 'node:worker_threads'

const sync = fs.fsyncSync,
  rename = fs.renameSync
let barriers = 0
fs.fsyncSync = (...args) => {
  sync(...args)
  if (++barriers === 1 && workerData.phase === 'file-sync') process.exit(91)
}
fs.renameSync = (...args) => {
  rename(...args)
  if (workerData.phase === 'rename') process.exit(91)
}
syncBuiltinESMExports()
await import('../lib/archive-worker.js')
