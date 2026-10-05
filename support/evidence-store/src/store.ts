/** This connection and all synchronous work belong exclusively to the storage worker. */

import { createHash } from 'node:crypto'
import type { BigIntStats, Dir } from 'node:fs'
import { existsSync, lstatSync, mkdirSync, opendirSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { decodeFrame, FRAME_LIMIT, type ObjectCodec } from './codec.ts'
import { readFrameFile } from './frame-file.ts'
import { EvidenceStateStore } from './state-store.ts'
import {
  type CapturedEvent,
  type CaptureResult,
  type ColdObject,
  type CompressedObject,
  type EvidenceHit,
  type Scope,
  type StoreStatus,
  validateScope,
} from './types.ts'

const MAX_OBJECT = 256 * 1024
const MAX_READ = 2 * 1024 * 1024
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
interface SpanRow {
  id: number
  eventId: string
  objectId: string
  startByte: number
  endByte: number
  role: string
  seq: number
  bytes: Buffer
  length: number
  codec: ObjectCodec
  path: string | null
  eventKey: number
  ordinal: number
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const selectSpan = `SELECT s.id, s.event_id AS eventKey, s.ordinal, e.host_id AS eventId, s.object_id AS objectId, s.start_byte AS startByte, s.end_byte AS endByte, e.role, e.seq, o.bytes, o.raw_length AS length, o.codec, o.path
  FROM spans s JOIN events e ON s.event_id = e.id JOIN objects o ON o.id = s.object_id`
const available = 's.session_id = ? AND s.available = 1 AND e.available = 1 AND o.available = 1'

/** Workspace storage with occurrence-preserving ingestion and session-filtered original-text search. */
export class SqliteEvidenceStore {
  private readonly db: Database.Database
  readonly sqliteVersion: string
  readonly stateStore: EvidenceStateStore
  readonly archiveDirectory: string | undefined
  private readonly cache = new Map<string, Buffer>()
  private cacheBytes = 0
  private orphanScan: Dir | undefined
  private orphanDirectoryIdentity: BigIntStats | undefined
  private readonly databasePath: string | undefined
  constructor(
    path: string,
    private readonly workspaceId: string,
  ) {
    if (!workspaceId || workspaceId.length > 512)
      throw new Error('A workspace identity is required')
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.archiveDirectory = path === ':memory:' ? undefined : resolve(dirname(path), 'objects')
    this.databasePath = path === ':memory:' ? undefined : resolve(path)
    this.sqliteVersion = this.db.prepare('SELECT sqlite_version()').pluck().get() as string
    const version = this.sqliteVersion.split('.').map(Number)
    if (version[0]! * 1e6 + version[1]! * 1e3 + version[2]! < 3_053_004) {
      this.db.close()
      throw new Error('Evidence storage requires SQLite 3.53.4 or newer')
    }
    try {
      this.db.pragma('journal_mode = WAL')
      for (const pragma of [
        'synchronous = FULL',
        'foreign_keys = ON',
        'trusted_schema = OFF',
        'busy_timeout = 5000',
        'cache_size = -32768',
        'wal_autocheckpoint = 1000',
        'journal_size_limit = 67108864',
      ])
        this.db.pragma(pragma)
      const mode = this.db.pragma('journal_mode', { simple: true })
      if (path !== ':memory:' && mode !== 'wal')
        throw new Error('Evidence storage could not enable WAL')
      const schemaVersion = this.db.pragma('user_version', { simple: true })
      if (schemaVersion !== 0 && schemaVersion !== 5)
        throw new Error('Unsupported evidence schema version')
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY, raw_length INTEGER NOT NULL CHECK(raw_length <= 262144), codec TEXT NOT NULL DEFAULT 'raw', bytes BLOB NOT NULL, path TEXT, stored_length INTEGER NOT NULL, access_revision INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL DEFAULT 1, last_access INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 0) STRICT;
        CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, host_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, interaction_group TEXT NOT NULL, closed INTEGER NOT NULL, metadata TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER)), available INTEGER NOT NULL DEFAULT 1, UNIQUE(session_id,host_id), UNIQUE(session_id,seq)) STRICT;
        CREATE TABLE IF NOT EXISTS spans(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, event_id INTEGER NOT NULL REFERENCES events(id), object_id TEXT NOT NULL REFERENCES objects(id), ordinal INTEGER NOT NULL, start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL, available INTEGER NOT NULL DEFAULT 1, UNIQUE(event_id,ordinal)) STRICT;
        CREATE INDEX IF NOT EXISTS spans_session ON spans(session_id,available,id);
        CREATE INDEX IF NOT EXISTS objects_archive_path ON objects(path) WHERE path IS NOT NULL;
        CREATE INDEX IF NOT EXISTS objects_cold ON objects(codec,last_access,generation);
        CREATE VIRTUAL TABLE IF NOT EXISTS spans_fts USING fts5(text, content='', contentless_delete=1);
        CREATE TABLE IF NOT EXISTS atoms(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, derivation TEXT NOT NULL, available INTEGER NOT NULL DEFAULT 1) STRICT;
        CREATE TABLE IF NOT EXISTS atom_sources(atom_id TEXT NOT NULL REFERENCES atoms(id), span_id INTEGER NOT NULL REFERENCES spans(id), PRIMARY KEY(atom_id,span_id)) STRICT;
        CREATE TABLE IF NOT EXISTS controls(session_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session_id,revision)) STRICT;
        CREATE TABLE IF NOT EXISTS manifests(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source_head INTEGER NOT NULL, control_revision INTEGER NOT NULL, body TEXT NOT NULL, request_hash TEXT NOT NULL, generation INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source_head INTEGER NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL, failure TEXT) STRICT;
        PRAGMA user_version = 5;
      `)
      const identity = this.db
        .prepare("SELECT value FROM meta WHERE key = 'workspace'")
        .pluck()
        .get()
      if (identity !== undefined && identity !== workspaceId)
        throw new Error('Evidence database belongs to another workspace')
      this.db
        .prepare("INSERT OR IGNORE INTO meta(key,value) VALUES ('workspace',?)")
        .run(workspaceId)
      this.db.pragma('optimize = 0x10002')
      const foreignKeys = this.db.pragma('foreign_key_check')
      if (
        this.db.pragma('quick_check', { simple: true }) !== 'ok' ||
        !Array.isArray(foreignKeys) ||
        foreignKeys.length
      )
        throw new Error('Evidence database failed integrity checks')
      this.stateStore = new EvidenceStateStore(this.db, workspaceId, (scope, ids) =>
        this.read(scope, ids),
      )
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  capture(scope: Scope, event: CapturedEvent): CaptureResult {
    validateScope(scope, this.workspaceId)
    if (
      !event.id ||
      !event.role ||
      !event.group ||
      typeof event.closed !== 'boolean' ||
      typeof event.text !== 'string'
    )
      throw new Error('Invalid captured event')
    if (
      Buffer.byteLength(event.text, 'utf8') > 8 * 1024 * 1024 ||
      Buffer.byteLength(JSON.stringify(event.metadata ?? {}), 'utf8') > 65536
    )
      throw new Error('Original evidence event exceeds its capture budget')
    const source = Buffer.from(event.text, 'utf8')
    if (utf8.decode(source) !== event.text) throw new Error('Evidence contains invalid Unicode')
    const fingerprint = sha(
      Buffer.from(
        JSON.stringify({
          id: event.id,
          role: event.role,
          group: event.group,
          text: event.text,
          metadata: event.metadata ?? {},
        }),
      ),
    )
    const insert = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT id,seq,fingerprint,available FROM events WHERE session_id=? AND host_id=?')
        .get(scope.sessionId, event.id) as
        | { id: number; seq: number; fingerprint: string; available: number }
        | undefined
      if (existing) {
        if (existing.fingerprint !== fingerprint || !existing.available)
          throw new Error('Captured event identity was reused or deleted')
        return {
          eventId: event.id,
          seq: existing.seq,
          evidenceIds: (
            this.db
              .prepare('SELECT id FROM spans WHERE event_id=? ORDER BY ordinal')
              .all(existing.id) as { id: number }[]
          ).map((row) => row.id),
        }
      }
      const seq = this.db
        .prepare('SELECT coalesce(max(seq),0)+1 FROM events WHERE session_id=?')
        .pluck()
        .get(scope.sessionId) as number
      const inserted = this.db
        .prepare(
          'INSERT INTO events(session_id,host_id,seq,role,interaction_group,closed,metadata,fingerprint) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          scope.sessionId,
          event.id,
          seq,
          event.role,
          event.group,
          Number(event.closed),
          JSON.stringify(event.metadata ?? {}),
          fingerprint,
        )
      const eventId = Number(inserted.lastInsertRowid)
      this.stateStore.changed(scope)
      const evidenceIds: number[] = []
      let ordinal = 0
      for (let start = 0; start < source.length; ) {
        let end = Math.min(start + MAX_OBJECT, source.length)
        if (end < source.length) while ((source[end]! & 0xc0) === 0x80) end--
        const bytes = source.subarray(start, end)
        const id = sha(bytes)
        this.db
          .prepare(
            'INSERT OR IGNORE INTO objects(id,raw_length,stored_length,bytes,last_access) VALUES (?,?,?,?,?)',
          )
          .run(id, bytes.length, bytes.length, bytes, Date.now())
        this.db
          .prepare(
            "UPDATE objects SET available=1,codec='raw',bytes=?,stored_length=?,path=NULL WHERE id=? AND available=0",
          )
          .run(bytes, bytes.length, id)
        this.db
          .prepare('UPDATE objects SET last_access=?,access_revision=access_revision+1 WHERE id=?')
          .run(Date.now(), id)
        for (let spanStart = 0; spanStart < bytes.length; ) {
          let spanEnd = Math.min(spanStart + 4096, bytes.length)
          if (spanEnd < bytes.length) while ((bytes[spanEnd]! & 0xc0) === 0x80) spanEnd--
          const span = this.db
            .prepare(
              'INSERT INTO spans(session_id,event_id,object_id,ordinal,start_byte,end_byte) VALUES (?,?,?,?,?,?)',
            )
            .run(scope.sessionId, eventId, id, ordinal++, spanStart, spanEnd)
          const spanId = Number(span.lastInsertRowid)
          this.db
            .prepare('INSERT INTO spans_fts(rowid,text) VALUES (?,?)')
            .run(spanId, utf8.decode(bytes.subarray(spanStart, spanEnd)))
          evidenceIds.push(spanId)
          spanStart = spanEnd
        }
        start = end
      }
      return { eventId: event.id, seq, evidenceIds }
    })
    return insert()
  }

  private materialize(rows: SpanRow[]): EvidenceHit[] {
    if (rows.length > 8 || rows.reduce((sum, row) => sum + row.length, 0) > MAX_READ)
      throw new Error('Evidence read exceeds its bounded page')
    return rows.map((row) => {
      if (
        !Number.isInteger(row.startByte) ||
        !Number.isInteger(row.endByte) ||
        row.startByte < 0 ||
        row.endByte < row.startByte ||
        row.endByte > row.length
      )
        throw new Error('Evidence span is corrupt')
      const bytes = this.object(row)
      const quote = utf8.decode(bytes.subarray(row.startByte, row.endByte))
      this.db
        .prepare('UPDATE objects SET last_access=?,access_revision=access_revision+1 WHERE id=?')
        .run(Date.now(), row.objectId)
      const adjacent = (ordinal: number) =>
        this.db
          .prepare('SELECT id FROM spans WHERE event_id=? AND ordinal=? AND available=1')
          .pluck()
          .get(row.eventKey, ordinal) as number | undefined
      const previousId = adjacent(row.ordinal - 1)
      const nextId = adjacent(row.ordinal + 1)
      return {
        id: row.id,
        eventId: row.eventId,
        objectId: row.objectId,
        startByte: row.startByte,
        endByte: row.endByte,
        quote,
        role: row.role,
        seq: row.seq,
        ...(previousId !== undefined ? { previousId } : {}),
        ...(nextId !== undefined ? { nextId } : {}),
      }
    })
  }
  private object(row: SpanRow): Buffer {
    const cached = this.cache.get(row.objectId)
    if (cached) {
      if (cached.length !== row.length) throw new Error('Evidence object metadata is corrupt')
      this.cache.delete(row.objectId)
      this.cache.set(row.objectId, cached)
      return cached
    }
    let bytes: Buffer
    if (row.codec === 'raw') bytes = row.bytes
    else {
      if (row.codec !== 'gzip' && row.codec !== 'zstd')
        throw new Error('Unknown persisted evidence codec')
      const expected = `${row.objectId}.${row.codec}.ev`
      if (row.path && (!this.archiveDirectory || row.path !== expected))
        throw new Error('Invalid evidence archive location')
      const frame = row.path ? readFrameFile(join(this.archiveDirectory!, expected)) : row.bytes
      bytes = decodeFrame(frame, row.codec, row.objectId, row.length)
    }
    if (bytes.length !== row.length || sha(bytes) !== row.objectId)
      throw new Error('Evidence object is corrupt')
    while (this.cache.size >= 8 || this.cacheBytes + bytes.length > MAX_READ) {
      const id = this.cache.keys().next().value as string
      this.cacheBytes -= this.cache.get(id)!.length
      this.cache.delete(id)
    }
    this.cache.set(row.objectId, bytes)
    this.cacheBytes += bytes.length
    return bytes
  }
  read(scope: Scope, ids: number[]): EvidenceHit[] {
    validateScope(scope, this.workspaceId)
    if (ids.length > 8 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
      throw new Error('Invalid evidence read page')
    const statement = this.db.prepare(`${selectSpan} WHERE ${available} AND s.id=?`)
    return this.materialize(
      ids
        .map((id) => statement.get(scope.sessionId, id) as SpanRow | undefined)
        .filter((row): row is SpanRow => !!row),
    )
  }
  search(scope: Scope, query: string, limit = 8): EvidenceHit[] {
    validateScope(scope, this.workspaceId)
    if (!Number.isInteger(limit) || limit < 1 || limit > 8 || query.length > 1024)
      throw new Error('Invalid evidence search budget')
    const terms = query.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 16) ?? []
    if (!terms.length) return []
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ')
    const rows = this.db
      .prepare(
        `${selectSpan} JOIN spans_fts ON spans_fts.rowid = s.id WHERE spans_fts MATCH ? AND ${available} ORDER BY rank LIMIT ?`,
      )
      .all(match, scope.sessionId, limit) as SpanRow[]
    return this.materialize(rows)
  }
  delete(scope: Scope, eventId: string): void {
    validateScope(scope, this.workspaceId)
    this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT id FROM events WHERE session_id=? AND host_id=?')
        .get(scope.sessionId, eventId) as { id: number } | undefined
      if (!row) return
      const spans = this.db.prepare('SELECT id FROM spans WHERE event_id=?').all(row.id) as {
        id: number
      }[]
      for (const span of spans) {
        this.db.prepare('DELETE FROM spans_fts WHERE rowid=?').run(span.id)
        this.db
          .prepare(
            'UPDATE atoms SET available=0 WHERE id IN (SELECT atom_id FROM atom_sources WHERE span_id=?)',
          )
          .run(span.id)
      }
      this.db.prepare('UPDATE spans SET available=0 WHERE event_id=?').run(row.id)
      this.db.prepare('UPDATE events SET available=0 WHERE id=?').run(row.id)
      this.db
        .prepare(
          "UPDATE jobs SET status='invalidated' WHERE session_id=? AND status IN ('queued','running')",
        )
        .run(scope.sessionId)
      this.stateStore.changed(scope)
      this.cache.clear()
      this.cacheBytes = 0
    })()
  }
  deleted(scope: Scope, eventIds: string[]): string[] {
    validateScope(scope, this.workspaceId)
    if (eventIds.length > 1024 || eventIds.some((id) => typeof id !== 'string' || id.length > 512))
      throw new Error('Invalid deletion observation budget')
    const statement = this.db.prepare(
      'SELECT 1 FROM events WHERE session_id=? AND host_id=? AND available=0',
    )
    return eventIds.filter((id) => statement.get(scope.sessionId, id))
  }
  /** Retire at most 32 events from complete inactive sessions; preserve live shared objects. */
  retire(before: number, protectedSessions: string[], limit: number): number {
    if (
      !Number.isSafeInteger(before) ||
      before < 0 ||
      protectedSessions.length > 1024 ||
      protectedSessions.some((id) => !id || id.length > 512) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 32
    )
      throw new Error('Invalid retention budget')
    const protectedIds = new Set(protectedSessions)
    const rows = this.db
      .prepare(`SELECT session_id AS id FROM events e GROUP BY session_id
      HAVING max(created_at)<? AND max(closed)=1 AND min(closed)=1 AND max(available)=1
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.session_id=e.session_id AND j.status='running') ORDER BY max(created_at) LIMIT 1024`)
      .all(before) as { id: string }[]
    const sessions = rows.filter((row) => !protectedIds.has(row.id)).slice(0, limit)
    let retired = 0
    this.db.transaction(() => {
      for (const { id } of sessions) {
        const scope = { workspaceId: this.workspaceId, sessionId: id }
        const events = this.db
          .prepare(
            'SELECT host_id AS id FROM events WHERE session_id=? AND available=1 ORDER BY seq LIMIT ?',
          )
          .all(id, limit - retired) as { id: string }[]
        for (const event of events) {
          this.delete(scope, event.id)
          retired++
        }
        if (retired >= limit) break
      }
      this.db
        .prepare(`UPDATE objects SET available=0,bytes=x'',stored_length=0,path=NULL,access_revision=access_revision+1
        WHERE id IN (SELECT id FROM objects o WHERE available=1 AND NOT EXISTS(SELECT 1 FROM spans s WHERE s.object_id=o.id AND s.available=1) LIMIT 8)`)
        .run()
    })()
    return retired
  }
  coldCandidates(now: number, limit: number): ColdObject[] {
    if (!Number.isFinite(now) || !Number.isInteger(limit) || limit < 1 || limit > 8)
      throw new Error('Invalid compression budget')
    const generation = this.db
      .prepare('SELECT coalesce(max(generation),0) FROM manifests')
      .pluck()
      .get() as number
    const rows = this.db
      .prepare(`SELECT id,raw_length AS length,bytes,access_revision AS revision,generation FROM objects o
      WHERE codec='raw' AND available=1 AND raw_length>=4096 AND last_access<=? AND generation<=?
      AND EXISTS (SELECT 1 FROM spans s JOIN events e ON e.id=s.event_id WHERE s.object_id=o.id AND s.available=1 AND e.available=1 AND e.closed=1)
      AND NOT EXISTS (SELECT 1 FROM spans s JOIN events e ON e.id=s.event_id WHERE s.object_id=o.id AND s.available=1 AND e.available=1 AND e.closed=0)
      ORDER BY last_access,id LIMIT ?`)
      .all(now - 24 * 3600_000, generation - 2, limit) as ColdObject[]
    if (rows.reduce((sum, row) => sum + row.length, 0) > MAX_READ)
      throw new Error('Compression page exceeds its decoded budget')
    for (const row of rows)
      if (row.bytes.length !== row.length || sha(row.bytes) !== row.id)
        throw new Error('Cold evidence object is corrupt')
    return rows
  }
  publishCompressed(candidate: ColdObject, encoded: CompressedObject): boolean {
    decodeFrame(encoded.frame, encoded.codec, candidate.id, candidate.length)
    const expected = `${candidate.id}.${encoded.codec}.ev`
    if (encoded.path && (!this.archiveDirectory || encoded.path !== expected))
      throw new Error('Invalid compression publication path')
    if (encoded.path)
      decodeFrame(
        readFrameFile(join(this.archiveDirectory!, encoded.path)),
        encoded.codec,
        candidate.id,
        candidate.length,
      )
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE objects SET codec=?,bytes=?,path=?,stored_length=?,access_revision=access_revision+1 WHERE id=? AND codec='raw' AND access_revision=? AND generation=? AND available=1",
        )
        .run(
          encoded.codec,
          encoded.path ? Buffer.alloc(0) : Buffer.from(encoded.frame),
          encoded.path ?? null,
          encoded.frame.byteLength,
          candidate.id,
          candidate.revision,
          candidate.generation,
        )
      const cached = this.cache.get(candidate.id)
      if (cached && result.changes) {
        this.cacheBytes -= cached.length
        this.cache.delete(candidate.id)
      }
      return result.changes > 0
    })()
  }
  /** Incremental idle sweep. Referenced data is retained regardless of availability/retention state. */
  cleanupOrphans(now: number, limit = 32): number {
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 64
    )
      throw new Error('Invalid archive cleanup budget')
    if (!this.archiveDirectory || !existsSync(this.archiveDirectory)) return 0
    const folder = lstatSync(this.archiveDirectory, { bigint: true })
    if (!folder.isDirectory()) return 0
    if (
      this.orphanScan &&
      (folder.dev !== this.orphanDirectoryIdentity?.dev ||
        folder.ino !== this.orphanDirectoryIdentity?.ino)
    ) {
      this.orphanScan.closeSync()
      this.orphanScan = undefined
    }
    if (!this.orphanScan) {
      this.orphanScan = opendirSync(this.archiveDirectory)
      this.orphanDirectoryIdentity = folder
    }
    let removed = 0
    for (let visited = 0; visited < limit; visited++) {
      const entry = this.orphanScan.readSync()
      if (!entry) {
        this.orphanScan.closeSync()
        this.orphanScan = undefined
        break
      }
      const frame = /^([a-f0-9]{64})\.(gzip|zstd)\.ev$/.exec(entry.name)
      const temporary =
        /^[a-f0-9]{64}\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(
          entry.name,
        )
      if (
        (!frame && !temporary) ||
        this.db.prepare('SELECT 1 FROM objects WHERE path=?').get(entry.name)
      )
        continue
      const path = join(this.archiveDirectory, entry.name)
      let before: BigIntStats
      try {
        before = lstatSync(path, { bigint: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size > BigInt(FRAME_LIMIT) ||
        Number(before.mtimeMs) > now - 86400000
      )
        continue
      if (frame) {
        try {
          const bytes = readFrameFile(path)
          decodeFrame(bytes, frame[2] as 'gzip' | 'zstd', frame[1]!, bytes.readUInt32LE(8))
        } catch {
          continue
        }
      }
      const location = lstatSync(this.archiveDirectory, { bigint: true })
      if (!location.isDirectory() || location.dev !== folder.dev || location.ino !== folder.ino) {
        this.orphanScan.closeSync()
        this.orphanScan = undefined
        break
      }
      let current: BigIntStats
      try {
        current = lstatSync(path, { bigint: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.size !== before.size ||
        current.mtimeNs !== before.mtimeNs ||
        current.ctimeNs !== before.ctimeNs ||
        !current.isFile()
      )
        continue
      unlinkSync(path)
      removed++
    }
    return removed
  }
  status(): StoreStatus {
    const count = (table: string) =>
      this.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number
    const sizes = this.db
      .prepare(
        'SELECT coalesce(sum(raw_length),0) AS rawBytes,coalesce(sum(stored_length),0) AS storedBytes FROM objects',
      )
      .get() as { rawBytes: number; storedBytes: number }
    let allocatedBytes = 0
    let allocatedBytesComplete = true
    const allocated = (path: string) => {
      if (existsSync(path)) {
        const stat = lstatSync(path)
        if (stat.isFile()) allocatedBytes += stat.blocks > 0 ? stat.blocks * 512 : stat.size
      }
    }
    if (this.databasePath)
      for (const suffix of ['', '-wal', '-shm']) allocated(this.databasePath + suffix)
    if (this.archiveDirectory && existsSync(this.archiveDirectory)) {
      const directory = opendirSync(this.archiveDirectory)
      try {
        let visited = 0
        for (;;) {
          const entry = directory.readSync()
          if (!entry) break
          if (++visited > 10_000) {
            allocatedBytesComplete = false
            break
          }
          if (entry.isFile()) allocated(join(this.archiveDirectory, entry.name))
        }
      } finally {
        directory.closeSync()
      }
    }
    const archiveFileObjects = this.db
      .prepare('SELECT count(*) FROM objects WHERE path IS NOT NULL')
      .pluck()
      .get() as number
    return {
      sqliteVersion: this.sqliteVersion,
      events: count('events'),
      objects: count('objects'),
      spans: count('spans'),
      archiveFileObjects,
      ...sizes,
      allocatedBytes,
      allocatedBytesComplete,
    }
  }
  close(): void {
    this.orphanScan?.closeSync()
    this.orphanScan = undefined
    this.db.pragma('optimize')
    this.db.close()
  }
}
