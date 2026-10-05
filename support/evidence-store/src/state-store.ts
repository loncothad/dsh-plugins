import { createHash } from 'node:crypto'
import { LeaseJournal } from '@loncothad/dsh-execution-core'
/** Transactional control versions, extraction coverage, and self-contained request manifests. */
import type Database from 'better-sqlite3'
import {
  EXTRACTOR_INSTRUCTION_HASH,
  EXTRACTOR_VERSION,
  type MemoryAtom,
  validateAtoms,
} from './memory.ts'
import { materializeRecipe, recipeEvidence } from './replay.ts'
import {
  type ControlRecord,
  type EvidenceHit,
  type ExtractionDiagnostics,
  type ExtractionJob,
  type ExtractionPolicy,
  type JobReport,
  type Manifest,
  type ManifestInput,
  type Scope,
  type SourceState,
  validateScope,
} from './types.ts'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const same = (a: SourceState, b: SourceState) =>
  a.head === b.head &&
  a.revision === b.revision &&
  a.controlRevision === b.controlRevision &&
  a.policyRevision === b.policyRevision
interface JobRow {
  id: string
  status: string
  attempts: number
  body: string
}

export class EvidenceStateStore {
  private readonly leases: LeaseJournal
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
    private readonly read: (scope: Scope, ids: number[]) => EvidenceHit[],
  ) {
    this.leases = new LeaseJournal(db)
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_versions(session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS policies(session_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session_id,revision)) STRICT;
      CREATE TABLE IF NOT EXISTS job_sources(job_id TEXT NOT NULL REFERENCES jobs(id), span_id INTEGER NOT NULL REFERENCES spans(id), PRIMARY KEY(job_id,span_id)) STRICT;
      CREATE TABLE IF NOT EXISTS job_costs(job_id TEXT NOT NULL REFERENCES jobs(id), attempt INTEGER NOT NULL, session_id TEXT NOT NULL, reserved REAL NOT NULL, report TEXT, PRIMARY KEY(job_id,attempt)) STRICT;
      CREATE TABLE IF NOT EXISTS job_results(job_id TEXT PRIMARY KEY REFERENCES jobs(id), fingerprint TEXT NOT NULL, atom_ids TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(session_id,status);
      CREATE INDEX IF NOT EXISTS job_sources_span ON job_sources(span_id);
      CREATE INDEX IF NOT EXISTS atoms_visible ON atoms(session_id,available);
    `)
    // Reservations survive interruption; a possibly billed call is never refunded by a restart.
    db.prepare(
      "UPDATE jobs SET status=CASE WHEN attempts<2 THEN 'queued' ELSE 'gap' END,failure='Extraction interrupted before settlement' WHERE status='running'",
    ).run()
    // The enclosing store holds an exclusive workspace worker lock. Restart invalidates prior ownership,
    // while retained reservations account for an API call whose outcome is unknown.
    db.prepare(
      "UPDATE execution_jobs SET lease_until=0 WHERE kind='extraction' AND status='running'",
    ).run()
  }
  private leaseScope(scope: Scope): string {
    return `${hash(scope)}/extraction`
  }
  private leaseId(id: string): string {
    return `extraction:${id}`
  }
  private assertLease(scope: Scope, job: ExtractionJob): void {
    const lease = this.leases.get(this.leaseId(job.id))
    if (
      !job.leaseToken ||
      !lease ||
      lease.scope !== this.leaseScope(scope) ||
      lease.status !== 'running' ||
      lease.leaseToken !== job.leaseToken ||
      lease.leaseUntil === null ||
      lease.leaseUntil <= Date.now()
    )
      throw new Error('Extraction lease expired or was replaced')
  }
  changed(scope: Scope): void {
    this.db
      .prepare(
        'INSERT INTO session_versions(session_id,revision) VALUES (?,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1',
      )
      .run(scope.sessionId)
  }
  state(scope: Scope): SourceState {
    validateScope(scope, this.workspaceId)
    const scalar = (query: string) => this.db.prepare(query).pluck().get(scope.sessionId) as number
    return {
      head: scalar('SELECT coalesce(max(seq),0) FROM events WHERE session_id=?'),
      revision: scalar(
        'SELECT coalesce((SELECT revision FROM session_versions WHERE session_id=?),0)',
      ),
      controlRevision: scalar('SELECT coalesce(max(revision),0) FROM controls WHERE session_id=?'),
      policyRevision: scalar('SELECT coalesce(max(revision),0) FROM policies WHERE session_id=?'),
    }
  }
  seal(scope: Scope, group: string): void {
    validateScope(scope, this.workspaceId)
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          'UPDATE events SET closed=1 WHERE session_id=? AND interaction_group=? AND closed=0 AND available=1',
        )
        .run(scope.sessionId, group)
      if (result.changes) this.changed(scope)
    })()
  }
  controls(scope: Scope, expectedRevision: number, records: ControlRecord[]): SourceState {
    validateScope(scope, this.workspaceId)
    if (
      records.length > 128 ||
      new Set(records.map((row) => row.id)).size !== records.length ||
      records.some(
        (row) =>
          !row.id ||
          !['pin', 'task', 'approval', 'supersession'].includes(row.kind) ||
          !['user', 'developer', 'system'].includes(row.role) ||
          typeof row.text !== 'string' ||
          row.text.length > 16384,
      )
    )
      throw new Error('Invalid host control records')
    return this.db.transaction(() => {
      const state = this.state(scope)
      if (state.controlRevision !== expectedRevision) throw new Error('Control revision changed')
      this.db
        .prepare('INSERT INTO controls(session_id,revision,body) VALUES (?,?,?)')
        .run(scope.sessionId, expectedRevision + 1, JSON.stringify(records))
      return this.state(scope)
    })()
  }
  readControls(scope: Scope, revision = this.state(scope).controlRevision): ControlRecord[] {
    validateScope(scope, this.workspaceId)
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid control version')
    if (revision === 0) return []
    const body = this.db
      .prepare('SELECT body FROM controls WHERE session_id=? AND revision=?')
      .pluck()
      .get(scope.sessionId, revision) as string | undefined
    if (body === undefined) throw new Error('Control version is unavailable')
    return JSON.parse(body) as ControlRecord[]
  }
  policy(scope: Scope, policy: ExtractionPolicy): SourceState {
    validateScope(scope, this.workspaceId)
    if (
      typeof policy.enabled !== 'boolean' ||
      typeof policy.allowUnknownBilling !== 'boolean' ||
      typeof policy.provider !== 'string' ||
      typeof policy.model !== 'string' ||
      !policy.promptVersion ||
      (policy.enabled && (!policy.provider || !policy.model)) ||
      !Number.isFinite(policy.budgetUsd) ||
      policy.budgetUsd < 0 ||
      [policy.inputUsdPerMillion, policy.outputUsdPerMillion].some(
        (rate) => rate !== undefined && (!Number.isFinite(rate) || rate < 0),
      )
    )
      throw new Error('Invalid extraction policy')
    const body = JSON.stringify(policy)
    return this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT body FROM policies WHERE session_id=? ORDER BY revision DESC LIMIT 1')
        .pluck()
        .get(scope.sessionId)
      if (current !== body)
        this.db
          .prepare('INSERT INTO policies(session_id,revision,body) VALUES (?,?,?)')
          .run(scope.sessionId, this.state(scope).policyRevision + 1, body)
      return this.state(scope)
    })()
  }
  private policyOf(scope: Scope): ExtractionPolicy | undefined {
    const body = this.db
      .prepare('SELECT body FROM policies WHERE session_id=? ORDER BY revision DESC LIMIT 1')
      .pluck()
      .get(scope.sessionId) as string | undefined
    return body === undefined ? undefined : (JSON.parse(body) as ExtractionPolicy)
  }
  pending(scope: Scope, limit: number): EvidenceHit[] {
    validateScope(scope, this.workspaceId)
    if (!Number.isInteger(limit) || limit < 1 || limit > 8)
      throw new Error('Invalid extraction page')
    const ids = this.db
      .prepare(`SELECT s.id FROM spans s JOIN events e ON e.id=s.event_id
      WHERE s.session_id=? AND s.available=1 AND e.available=1 AND e.closed=1
      AND NOT EXISTS (SELECT 1 FROM job_sources js JOIN jobs j ON j.id=js.job_id WHERE js.span_id=s.id AND
        (j.status='complete' OR (j.status IN ('queued','running','gap') AND json_extract(j.body,'$.state.policyRevision')=?)))
      ORDER BY e.seq,s.ordinal LIMIT ?`)
      .all(scope.sessionId, this.state(scope).policyRevision, limit) as { id: number }[]
    return this.read(
      scope,
      ids.map((row) => row.id),
    )
  }
  enqueue(scope: Scope, evidenceIds: number[], sourceTokens: number): string {
    validateScope(scope, this.workspaceId)
    if (
      !evidenceIds.length ||
      evidenceIds.length > 8 ||
      new Set(evidenceIds).size !== evidenceIds.length ||
      !Number.isInteger(sourceTokens) ||
      sourceTokens < 1 ||
      sourceTokens > 8000
    )
      throw new Error('Invalid extraction window')
    return this.db.transaction(() => {
      const evidence = this.read(scope, evidenceIds)
      if (evidence.length !== evidenceIds.length)
        throw new Error('Extraction source is unavailable')
      const open = this.db
        .prepare(
          `SELECT count(*) FROM spans s JOIN events e ON e.id=s.event_id WHERE s.id IN (${evidenceIds.map(() => '?').join(',')}) AND e.closed=0`,
        )
        .pluck()
        .get(...evidenceIds)
      if (open) throw new Error('Extraction requires closed interactions')
      const policy = this.policyOf(scope)
      if (!policy?.enabled) throw new Error('Extraction egress is not approved')
      const state = this.state(scope)
      const id = hash({
        scope,
        evidenceIds,
        state,
        instructionHash: EXTRACTOR_INSTRUCTION_HASH,
        extractorVersion: EXTRACTOR_VERSION,
        provider: policy.provider,
        model: policy.model,
        promptVersion: policy.promptVersion,
      })
      const job: ExtractionJob = {
        instructionHash: EXTRACTOR_INSTRUCTION_HASH,
        extractorVersion: EXTRACTOR_VERSION,
        id,
        scope,
        state,
        evidenceIds,
        sourceTokens,
        provider: policy.provider,
        model: policy.model,
        promptVersion: policy.promptVersion,
        attempt: 0,
      }
      this.db
        .prepare(
          "INSERT OR IGNORE INTO jobs(id,session_id,source_head,status,body) VALUES (?,?,?,'queued',?)",
        )
        .run(id, scope.sessionId, state.head, JSON.stringify(job))
      for (const spanId of evidenceIds)
        this.db
          .prepare('INSERT OR IGNORE INTO job_sources(job_id,span_id) VALUES (?,?)')
          .run(id, spanId)
      return id
    })()
  }
  private job(scope: Scope, id: string): JobRow {
    const row = this.db
      .prepare('SELECT id,status,attempts,body FROM jobs WHERE id=? AND session_id=?')
      .get(id, scope.sessionId) as JobRow | undefined
    if (!row) throw new Error('Extraction job is unavailable')
    return row
  }
  claim(scope: Scope): ExtractionJob | undefined {
    validateScope(scope, this.workspaceId)
    return this.db.transaction(() => {
      const policy = this.policyOf(scope)
      if (!policy?.enabled) return undefined
      this.db
        .prepare(
          "UPDATE execution_jobs SET status='dead',lease_token=NULL,lease_until=NULL,reason='Extraction source or policy became unavailable' WHERE scope=? AND kind='extraction' AND status IN ('queued','running') AND EXISTS(SELECT 1 FROM jobs j WHERE 'extraction:'||j.id=execution_jobs.id AND j.status IN ('invalidated','gap'))",
        )
        .run(this.leaseScope(scope))
      this.db
        .prepare(
          "UPDATE jobs SET status=CASE WHEN attempts<2 THEN 'queued' ELSE 'gap' END,failure='Extraction lease expired before settlement' WHERE session_id=? AND status='running' AND EXISTS(SELECT 1 FROM execution_jobs x WHERE x.id='extraction:'||jobs.id AND x.lease_until<=?)",
        )
        .run(scope.sessionId, Date.now())
      const row = this.db
        .prepare(
          "SELECT id,status,attempts,body FROM jobs WHERE session_id=? AND status='queued' AND attempts<2 ORDER BY rowid LIMIT 1",
        )
        .get(scope.sessionId) as JobRow | undefined
      if (!row) return undefined
      const job = JSON.parse(row.body) as ExtractionJob
      const state = this.state(scope)
      const sources = this.read(scope, job.evidenceIds)
      if (
        job.state.policyRevision !== state.policyRevision ||
        job.state.controlRevision !== state.controlRevision ||
        sources.length !== job.evidenceIds.length
      ) {
        this.db
          .prepare(
            "UPDATE jobs SET status='invalidated',failure='Source, controls, or policy changed' WHERE id=?",
          )
          .run(row.id)
        return undefined
      }
      const unknown =
        policy.inputUsdPerMillion === undefined || policy.outputUsdPerMillion === undefined
      const reserved =
        (9000 * (policy.inputUsdPerMillion ?? 0) + 1500 * (policy.outputUsdPerMillion ?? 0)) / 1e6
      const spent = this.db
        .prepare('SELECT coalesce(sum(reserved),0) FROM job_costs WHERE session_id=?')
        .pluck()
        .get(scope.sessionId) as number
      if ((unknown && !policy.allowUnknownBilling) || spent + reserved > policy.budgetUsd) {
        this.db
          .prepare("UPDATE jobs SET status='gap',failure=? WHERE id=?")
          .run(
            unknown && !policy.allowUnknownBilling
              ? 'No approved billing policy'
              : 'Extraction budget exhausted',
            row.id,
          )
        return undefined
      }
      const attempt = row.attempts + 1
      this.leases.submit({
        id: this.leaseId(row.id),
        scope: this.leaseScope(scope),
        kind: 'extraction',
        payload: { jobId: row.id },
        maxAttempts: 2,
        retrySafe: true,
      })
      const lease = this.leases.claim(this.leaseScope(scope), 360000)
      if (!lease || lease.job.id !== this.leaseId(row.id))
        throw new Error('Extraction lease admission changed')
      this.db
        .prepare("UPDATE jobs SET status='running',attempts=?,failure=NULL WHERE id=?")
        .run(attempt, row.id)
      this.db
        .prepare('INSERT INTO job_costs(job_id,attempt,session_id,reserved) VALUES (?,?,?,?)')
        .run(row.id, attempt, scope.sessionId, reserved)
      return { ...job, attempt, leaseToken: lease.token, leaseUntil: lease.until }
    })()
  }
  private report(scope: Scope, job: ExtractionJob, report: JobReport): void {
    if (
      [report.inputTokens, report.outputTokens, report.costUsd].some(
        (value) => value !== undefined && (!Number.isFinite(value) || value < 0),
      ) ||
      typeof report.unknownBilling !== 'boolean'
    )
      throw new Error('Invalid extraction billing report')
    this.db
      .prepare(
        'UPDATE job_costs SET reserved=max(reserved,coalesce(?,reserved)),report=? WHERE job_id=? AND attempt=? AND session_id=?',
      )
      .run(report.costUsd ?? null, JSON.stringify(report), job.id, job.attempt, scope.sessionId)
  }
  publish(scope: Scope, claimed: ExtractionJob, payload: unknown, report: JobReport): string[] {
    validateScope(scope, this.workspaceId)
    return this.db.transaction(() => {
      const row = this.job(scope, claimed.id)
      if (row.status === 'complete' && row.attempts === claimed.attempt) {
        const prior = this.db
          .prepare('SELECT fingerprint,atom_ids FROM job_results WHERE job_id=?')
          .get(row.id) as { fingerprint: string; atom_ids: string } | undefined
        if (!prior || prior.fingerprint !== hash(payload))
          throw new Error('Extraction job was completed with another result')
        return JSON.parse(prior.atom_ids) as string[]
      }
      this.assertLease(scope, claimed)
      const job = JSON.parse(row.body) as ExtractionJob
      const state = this.state(scope)
      if (
        row.status !== 'running' ||
        row.attempts !== claimed.attempt ||
        state.policyRevision !== job.state.policyRevision ||
        state.controlRevision !== job.state.controlRevision
      )
        throw new Error('Extraction publication is stale')
      const evidence = this.read(scope, job.evidenceIds)
      if (evidence.length !== job.evidenceIds.length)
        throw new Error('Extraction source was deleted')
      const atoms = validateAtoms(payload, {
        scope,
        evidence,
        provider: job.provider,
        model: job.model,
        promptVersion: job.promptVersion,
        instructionHash: job.instructionHash,
        extractorVersion: job.extractorVersion,
        sourceHead: job.state.head,
        sourceRevision: job.state.revision,
        controlRevision: job.state.controlRevision,
        policyRevision: job.state.policyRevision,
      })
      for (const atom of atoms) {
        const { body, ...metadata } = atom
        this.db
          .prepare(
            'INSERT OR IGNORE INTO atoms(id,session_id,kind,body,derivation) VALUES (?,?,?,?,?)',
          )
          .run(
            atom.id,
            scope.sessionId,
            atom.kind,
            atom.exact ? '' : body,
            JSON.stringify(metadata),
          )
        for (const spanId of atom.evidenceIds)
          this.db
            .prepare('INSERT OR IGNORE INTO atom_sources(atom_id,span_id) VALUES (?,?)')
            .run(atom.id, spanId)
      }
      this.report(scope, claimed, report)
      this.db.prepare("UPDATE jobs SET status='complete' WHERE id=?").run(job.id)
      const ids = atoms.map((atom) => atom.id)
      this.db
        .prepare('INSERT INTO job_results(job_id,fingerprint,atom_ids) VALUES (?,?,?)')
        .run(job.id, hash(payload), JSON.stringify(ids))
      this.leases.complete(this.leaseId(job.id), claimed.leaseToken!, { atomIds: ids })
      return ids
    })()
  }
  gap(scope: Scope, claimed: ExtractionJob, report: JobReport, retry: boolean): void {
    validateScope(scope, this.workspaceId)
    this.db.transaction(() => {
      const row = this.job(scope, claimed.id)
      if (row.attempts !== claimed.attempt) throw new Error('Extraction attempt is stale')
      this.assertLease(scope, claimed)
      this.report(scope, claimed, report)
      if (row.status === 'running')
        this.db
          .prepare('UPDATE jobs SET status=?,failure=? WHERE id=?')
          .run(
            retry && row.attempts < 2 ? 'queued' : 'gap',
            report.gap ?? 'Extraction failed',
            claimed.id,
          )
      this.leases.fail(
        this.leaseId(claimed.id),
        claimed.leaseToken!,
        report.gap ?? 'Extraction failed',
        retry,
        0,
      )
    })()
  }
  diagnostics(scope: Scope): ExtractionDiagnostics {
    validateScope(scope, this.workspaceId)
    const count = (status: string) =>
      this.db
        .prepare('SELECT count(*) FROM jobs WHERE session_id=? AND status=?')
        .pluck()
        .get(scope.sessionId, status) as number
    return {
      queued: count('queued'),
      running: count('running'),
      complete: count('complete'),
      gaps: count('gap') + count('invalidated'),
      reservedUsd: this.db
        .prepare('SELECT coalesce(sum(reserved),0) FROM job_costs WHERE session_id=?')
        .pluck()
        .get(scope.sessionId) as number,
      unknownBillingAttempts: this.db
        .prepare(
          "SELECT count(*) FROM job_costs WHERE session_id=? AND (report IS NULL OR json_extract(report,'$.unknownBilling')=1)",
        )
        .pluck()
        .get(scope.sessionId) as number,
      recentGaps: this.db
        .prepare(
          "SELECT id AS jobId,coalesce(failure,'Source unavailable') AS reason FROM jobs WHERE session_id=? AND status IN ('gap','invalidated') ORDER BY rowid DESC LIMIT 16",
        )
        .all(scope.sessionId) as { jobId: string; reason: string }[],
    }
  }
  atoms(scope: Scope, limit: number): MemoryAtom[] {
    validateScope(scope, this.workspaceId)
    if (!Number.isInteger(limit) || limit < 1 || limit > 48)
      throw new Error('Invalid memory atom budget')
    const rows = this.db
      .prepare(`SELECT a.id,a.body,a.derivation FROM atoms a WHERE a.session_id=? AND a.available=1
      AND NOT EXISTS (SELECT 1 FROM atom_sources x JOIN spans s ON s.id=x.span_id JOIN events e ON e.id=s.event_id WHERE x.atom_id=a.id AND (s.available=0 OR e.available=0))
      ORDER BY a.rowid DESC LIMIT ?`)
      .all(scope.sessionId, limit) as { id: string; body: string; derivation: string }[]
    return rows.map((row) => {
      const meta = JSON.parse(row.derivation) as Omit<MemoryAtom, 'body'>
      const evidence = this.read(scope, meta.evidenceIds)
      const atom = validateAtoms(
        {
          atoms: [
            {
              kind: meta.kind,
              body: meta.exact ? 'Original source' : row.body,
              evidenceIds: meta.evidenceIds,
            },
          ],
        },
        { scope, evidence, ...meta.derivation },
      )[0]!
      if (atom.id !== row.id) throw new Error('Memory atom is corrupt')
      return atom
    })
  }
  manifest(scope: Scope, input: ManifestInput): Manifest {
    validateScope(scope, this.workspaceId)
    if (
      !/^[a-f0-9]{64}$/.test(input.requestHash) ||
      !Number.isSafeInteger(input.inputTokens) ||
      input.inputTokens < 0 ||
      !input.adapterVersion ||
      !input.rendererVersion ||
      input.selected.length > 2048 ||
      input.atomIds.length > 48
    )
      throw new Error('Invalid request manifest')
    return this.db.transaction(() => {
      if (!same(this.state(scope), input.state))
        throw new Error('Source, controls, or policy changed before request publication')
      const selectedIds = new Set(input.selected.flatMap((unit) => unit.evidenceIds))
      if (recipeEvidence(input.request).some((id) => !selectedIds.has(id)))
        throw new Error('Replay references unselected evidence')
      const ids = [...selectedIds]
      if (ids.length > 4096) throw new Error('Manifest evidence budget exceeded')
      for (let offset = 0; offset < ids.length; offset += 8)
        if (
          this.read(scope, ids.slice(offset, offset + 8)).length !==
          Math.min(8, ids.length - offset)
        )
          throw new Error('Manifest selected unavailable evidence')
      for (const id of input.atomIds)
        if (
          !this.db
            .prepare('SELECT 1 FROM atoms WHERE id=? AND session_id=? AND available=1')
            .get(id, scope.sessionId)
        )
          throw new Error('Manifest selected unavailable memory')
      materializeRecipe(input.request, (ids) => this.read(scope, ids), input.requestHash)
      const generation = this.db
        .prepare('SELECT coalesce(max(generation),0)+1 FROM manifests')
        .pluck()
        .get() as number
      const id = hash({ scope, ...input })
      const value: Manifest = { ...input, id, scope, generation }
      const prior = this.db
        .prepare('SELECT body FROM manifests WHERE id=? AND session_id=?')
        .pluck()
        .get(id, scope.sessionId) as string | undefined
      if (prior) return JSON.parse(prior) as Manifest
      this.db
        .prepare(
          'INSERT INTO manifests(id,session_id,source_head,control_revision,body,request_hash,generation) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          id,
          scope.sessionId,
          input.state.head,
          input.state.controlRevision,
          JSON.stringify(value),
          input.requestHash,
          generation,
        )
      for (const spanId of ids)
        this.db
          .prepare(
            'UPDATE objects SET generation=?,last_access=?,access_revision=access_revision+1 WHERE id=(SELECT object_id FROM spans WHERE id=?)',
          )
          .run(generation, Date.now(), spanId)
      return value
    })()
  }
  replay(scope: Scope, id: string): Manifest {
    validateScope(scope, this.workspaceId)
    const body = this.db
      .prepare('SELECT body FROM manifests WHERE id=? AND session_id=?')
      .pluck()
      .get(id, scope.sessionId) as string | undefined
    if (!body) throw new Error('Request manifest is unavailable')
    return JSON.parse(body) as Manifest
  }
  replayRequest(scope: Scope, id: string): unknown {
    const manifest = this.replay(scope, id)
    const ids = [...new Set(manifest.selected.flatMap((unit) => unit.evidenceIds))]
    for (let offset = 0; offset < ids.length; offset += 8)
      if (
        this.read(scope, ids.slice(offset, offset + 8)).length !== Math.min(8, ids.length - offset)
      )
        throw new Error('Replay selected evidence is unavailable')
    for (const atom of manifest.atomIds)
      if (
        !this.db
          .prepare('SELECT 1 FROM atoms WHERE id=? AND session_id=? AND available=1')
          .get(atom, scope.sessionId)
      )
        throw new Error('Replay memory is unavailable')
    return materializeRecipe(manifest.request, (ids) => this.read(scope, ids), manifest.requestHash)
  }
  manifestAvailable(scope: Scope, id: string): boolean {
    const manifest = this.replay(scope, id)
    const ids = new Set([
      ...manifest.selected.flatMap((unit) => unit.evidenceIds),
      ...recipeEvidence(manifest.request),
    ])
    const span = this.db.prepare(
      'SELECT 1 FROM spans s JOIN events e ON e.id=s.event_id JOIN objects o ON o.id=s.object_id WHERE s.id=? AND s.session_id=? AND s.available=1 AND e.available=1 AND o.available=1',
    )
    const atom = this.db.prepare('SELECT 1 FROM atoms WHERE id=? AND session_id=? AND available=1')
    return (
      [...ids].every((id) => !!span.get(id, scope.sessionId)) &&
      manifest.atomIds.every((id) => !!atom.get(id, scope.sessionId))
    )
  }
}
