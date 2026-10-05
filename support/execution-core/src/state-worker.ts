/** Private plugin snapshots. They never add vocabulary to the upstream session log. */
import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { canonical } from './configuration.ts'

const db = new Database(String(workerData.path))
db.pragma('busy_timeout=5000')
db.pragma('journal_mode=WAL')
db.pragma('synchronous=FULL')
db.pragma('trusted_schema=OFF')
db.exec(
  'CREATE TABLE IF NOT EXISTS plugin_snapshots(scope TEXT NOT NULL, revision INTEGER NOT NULL, anchor INTEGER NOT NULL, observed_at INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,revision)) STRICT; CREATE INDEX IF NOT EXISTS plugin_snapshot_cut ON plugin_snapshots(scope,anchor,observed_at);',
)
parentPort!.on(
  'message',
  ({ id, operation, args }: { id: number; operation: string; args: unknown[] }) => {
    try {
      if (operation === 'close') {
        db.close()
        parentPort!.postMessage({ id, value: null })
        parentPort!.close()
        return
      }
      const [scope] = args
      if (typeof scope !== 'string' || !scope || scope.length > 256)
        throw new Error('Invalid snapshot scope')
      let value: unknown
      if (operation === 'read') {
        const anchor = args[1],
          before = args[2]
        if (!Number.isSafeInteger(anchor) || !Number.isSafeInteger(before))
          throw new Error('Invalid snapshot cut')
        value =
          db
            .prepare(
              'SELECT revision,anchor,observed_at AS observedAt,value FROM plugin_snapshots WHERE scope=? AND anchor<=? AND observed_at<? ORDER BY revision DESC LIMIT 1',
            )
            .get(scope, anchor, before) ?? null
        if (value)
          (value as { value: unknown }).value = JSON.parse(
            String((value as { value: unknown }).value),
          )
      } else if (operation === 'write') {
        const [, expected, anchor, input] = args,
          body = canonical(input)
        if (
          !Number.isSafeInteger(expected) ||
          Number(expected) < 0 ||
          !Number.isSafeInteger(anchor) ||
          Number(anchor) < -1 ||
          Buffer.byteLength(body) > 131072
        )
          throw new Error('Invalid snapshot')
        value = db
          .transaction(() => {
            const latest = db
              .prepare(
                'SELECT revision,observed_at AS observedAt FROM plugin_snapshots WHERE scope=? ORDER BY revision DESC LIMIT 1',
              )
              .get(scope) as { revision: number; observedAt: number } | undefined
            if ((latest?.revision ?? 0) !== expected) throw new Error('Snapshot revision changed')
            if (
              (db.prepare('SELECT count(*) FROM plugin_snapshots').pluck().get() as number) >=
              100000
            )
              throw new Error('Snapshot retention quota reached')
            const revision = Number(expected) + 1,
              observedAt = Math.max(Date.now(), (latest?.observedAt ?? 0) + 1)
            db.prepare('INSERT INTO plugin_snapshots VALUES (?,?,?,?,?)').run(
              scope,
              revision,
              anchor,
              observedAt,
              body,
            )
            return { revision, anchor, observedAt, value: JSON.parse(body) }
          })
          .immediate()
      } else throw new Error('Unknown snapshot operation')
      parentPort!.postMessage({ id, value })
    } catch {
      parentPort!.postMessage({ id, error: true })
    }
  },
)
