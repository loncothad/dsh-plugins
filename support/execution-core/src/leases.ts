import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { canonical } from './configuration.ts'
export interface ExecutionJob {
  id: string
  scope: string
  kind: string
  payload: unknown
  status: 'queued' | 'running' | 'complete' | 'dead'
  attempts: number
  maxAttempts: number
  retrySafe: boolean
  nextAt: number
  leaseToken: string | null
  leaseUntil: number | null
  result: unknown
  reason: string | null
}
export interface Lease {
  job: ExecutionJob
  token: string
  until: number
}
function bounded(value: string, name: string, max = 256): void {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Deliberate control-character filtering at an input or log boundary.
  if (!value || value.length > max || /[\u0000-\u001f]/.test(value))
    throw new Error(`Invalid ${name}`)
}
function clock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid execution clock')
}
export class LeaseJournal {
  constructor(private readonly db: Database.Database) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS execution_jobs(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL,max_attempts INTEGER NOT NULL,retry_safe INTEGER NOT NULL,next_at INTEGER NOT NULL,lease_token TEXT,lease_until INTEGER,result TEXT,reason TEXT) STRICT; CREATE INDEX IF NOT EXISTS execution_admission ON execution_jobs(scope,status,next_at);',
    )
  }
  submit(
    input: {
      id: string
      scope: string
      kind: string
      payload: unknown
      maxAttempts: number
      retrySafe: boolean
    },
    now = Date.now(),
  ): ExecutionJob {
    clock(now)
    bounded(input.id, 'job id', 128)
    bounded(input.scope, 'job scope')
    bounded(input.kind, 'job kind', 64)
    const payload = canonical(input.payload)
    if (
      payload.length > 131072 ||
      !Number.isSafeInteger(input.maxAttempts) ||
      input.maxAttempts < 1 ||
      input.maxAttempts > 16 ||
      !Number.isSafeInteger(now) ||
      now < 0
    )
      throw new Error('Invalid job limits')
    return this.db
      .transaction(() => {
        const prior = this.get(input.id)
        if (prior) {
          if (
            prior.scope !== input.scope ||
            prior.kind !== input.kind ||
            canonical(prior.payload) !== payload ||
            prior.maxAttempts !== input.maxAttempts ||
            prior.retrySafe !== input.retrySafe
          )
            throw new Error('Job identity already names another operation')
          return prior
        }
        if (
          (this.db
            .prepare("SELECT count(*) FROM execution_jobs WHERE status IN ('queued','running')")
            .pluck()
            .get() as number) >= 4096
        )
          throw new Error('Execution admission capacity exceeded')
        if (
          (this.db.prepare('SELECT count(*) FROM execution_jobs').pluck().get() as number) >= 100000
        )
          throw new Error('Execution journal retention quota exceeded')
        this.db
          .prepare(
            "INSERT INTO execution_jobs VALUES (?,?,?,?,'queued',0,?,?,?,NULL,NULL,NULL,NULL)",
          )
          .run(
            input.id,
            input.scope,
            input.kind,
            payload,
            input.maxAttempts,
            input.retrySafe ? 1 : 0,
            now,
          )
        return this.get(input.id)!
      })
      .immediate()
  }
  private row(value: Record<string, unknown>): ExecutionJob {
    return {
      id: String(value.id),
      scope: String(value.scope),
      kind: String(value.kind),
      payload: JSON.parse(String(value.payload)),
      status: value.status as ExecutionJob['status'],
      attempts: Number(value.attempts),
      maxAttempts: Number(value.max_attempts),
      retrySafe: Boolean(value.retry_safe),
      nextAt: Number(value.next_at),
      leaseToken: value.lease_token === null ? null : String(value.lease_token),
      leaseUntil: value.lease_until === null ? null : Number(value.lease_until),
      result: value.result === null ? null : JSON.parse(String(value.result)),
      reason: value.reason === null ? null : String(value.reason),
    }
  }
  get(id: string): ExecutionJob | undefined {
    const row = this.db.prepare('SELECT * FROM execution_jobs WHERE id=?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.row(row) : undefined
  }
  claim(scope: string, ttlMs: number, now = Date.now(), id?: string): Lease | undefined {
    clock(now)
    if (id !== undefined) bounded(id, 'job id', 128)
    bounded(scope, 'job scope')
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000)
      throw new Error('Invalid lease TTL')
    return this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE execution_jobs SET status=CASE WHEN retry_safe=1 AND attempts<max_attempts THEN 'queued' ELSE 'dead' END,lease_token=NULL,lease_until=NULL,reason='Worker lease expired; prior outcome may be unknown' WHERE scope=? AND status='running' AND lease_until<=?",
        )
        .run(scope, now)
      const raw = this.db
        .prepare(
          "SELECT * FROM execution_jobs WHERE scope=? AND status='queued' AND next_at<=? AND (? IS NULL OR id=?) ORDER BY next_at,rowid LIMIT 1",
        )
        .get(scope, now, id ?? null, id ?? null) as Record<string, unknown> | undefined
      if (!raw) return undefined
      const token = randomUUID(),
        until = now + ttlMs
      this.db
        .prepare(
          "UPDATE execution_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,reason=NULL WHERE id=?",
        )
        .run(token, until, raw.id)
      return { job: this.get(String(raw.id))!, token, until }
    })()
  }
  private assertLease(id: string, token: string, now: number): ExecutionJob {
    clock(now)
    const row = this.get(id)
    if (
      row?.status !== 'running' ||
      row.leaseToken !== token ||
      row.leaseUntil === null ||
      row.leaseUntil <= now
    )
      throw new Error('Execution lease expired or was replaced')
    return row
  }
  renew(id: string, token: string, ttlMs: number, now = Date.now()): number {
    return this.db
      .transaction(() => {
        this.assertLease(id, token, now)
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000)
          throw new Error('Invalid lease TTL')
        const until = now + ttlMs
        this.db
          .prepare('UPDATE execution_jobs SET lease_until=? WHERE id=? AND lease_token=?')
          .run(until, id, token)
        return until
      })
      .immediate()
  }
  complete(id: string, token: string, result: unknown, now = Date.now()): void {
    this.db
      .transaction(() => {
        this.assertLease(id, token, now)
        const body = canonical(result)
        if (body.length > 131072) throw new Error('Job result exceeds its limit')
        this.db
          .prepare(
            "UPDATE execution_jobs SET status='complete',result=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?",
          )
          .run(body, id, token)
      })
      .immediate()
  }
  fail(
    id: string,
    token: string,
    reason: string,
    retryable: boolean,
    backoffMs: number,
    now = Date.now(),
  ): void {
    this.db
      .transaction(() => {
        const job = this.assertLease(id, token, now)
        if (
          reason.length > 512 ||
          !Number.isSafeInteger(backoffMs) ||
          backoffMs < 0 ||
          backoffMs > 86400000
        )
          throw new Error('Invalid failure record')
        this.db
          .prepare(
            'UPDATE execution_jobs SET status=?,next_at=?,reason=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?',
          )
          .run(
            retryable && job.retrySafe && job.attempts < job.maxAttempts ? 'queued' : 'dead',
            now + backoffMs,
            reason,
            id,
            token,
          )
      })
      .immediate()
  }
  inspect(scope: string, status?: ExecutionJob['status'], limit = 64): ExecutionJob[] {
    bounded(scope, 'job scope')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new Error('Invalid inspection limit')
    return (
      status
        ? this.db
            .prepare(
              'SELECT * FROM execution_jobs WHERE scope=? AND status=? ORDER BY rowid DESC LIMIT ?',
            )
            .all(scope, status, limit)
        : this.db
            .prepare('SELECT * FROM execution_jobs WHERE scope=? ORDER BY rowid DESC LIMIT ?')
            .all(scope, limit)
    ).map((row) => this.row(row as Record<string, unknown>))
  }
  reap(now = Date.now(), limit = 256): number {
    clock(now)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new Error('Invalid reclamation batch')
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT id FROM execution_jobs WHERE status='running' AND lease_until<=? ORDER BY lease_until LIMIT ?",
        )
        .all(now, limit) as { id: string }[]
      for (const row of rows)
        this.db
          .prepare(
            "UPDATE execution_jobs SET status=CASE WHEN retry_safe=1 AND attempts<max_attempts THEN 'queued' ELSE 'dead' END,lease_token=NULL,lease_until=NULL,reason='Worker lease expired; prior outcome may be unknown' WHERE id=? AND status='running' AND lease_until<=?",
          )
          .run(row.id, now)
      return rows.length
    })()
  }
  retry(id: string, scope: string, reconciled: boolean, now = Date.now()): void {
    this.db
      .transaction(() => {
        clock(now)
        const job = this.get(id)
        if (
          !job ||
          job.scope !== scope ||
          job.status !== 'dead' ||
          (!job.retrySafe && !reconciled) ||
          job.attempts >= job.maxAttempts
        )
          throw new Error('Dead letter requires reconciliation and an available attempt')
        this.db
          .prepare(
            "UPDATE execution_jobs SET status='queued',next_at=?,reason=NULL WHERE id=? AND scope=?",
          )
          .run(now, id, scope)
      })
      .immediate()
  }
}
