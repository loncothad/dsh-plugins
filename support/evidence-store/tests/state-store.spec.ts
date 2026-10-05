import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { requestRecipe } from '../src/replay.ts'
import { SqliteEvidenceStore } from '../src/store.ts'
import type { ExtractionPolicy, ManifestInput } from '../src/types.ts'

const scope = { workspaceId: 'workspace', sessionId: 'session' }
const policy: ExtractionPolicy = {
  enabled: true,
  provider: 'fixture',
  model: 'extractor',
  promptVersion: '1',
  budgetUsd: 1,
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 1,
  allowUnknownBilling: false,
}
const source = {
  id: 'original',
  role: 'user',
  group: 'exchange',
  closed: true,
  text: 'Do not publish unless I explicitly approve the final result.',
}
const report = { inputTokens: 40, outputTokens: 30, costUsd: 0.00007, unknownBilling: false }

it('rejects a replaced lease token before publishing extraction atoms', () => {
  const store = new SqliteEvidenceStore(':memory:', 'workspace')
  try {
    const captured = store.capture(scope, source)
    store.stateStore.policy(scope, policy)
    store.stateStore.enqueue(scope, captured.evidenceIds, 40)
    const job = store.stateStore.claim(scope)!
    expect(job.leaseToken).toBeTruthy()
    expect(job.leaseUntil).toBeGreaterThan(Date.now())
    expect(() =>
      store.stateStore.publish(
        scope,
        { ...job, leaseToken: 'expired-worker' },
        { atoms: [] },
        report,
      ),
    ).toThrow('lease')
    expect(store.stateStore.atoms(scope, 48)).toHaveLength(0)
    expect(store.stateStore.publish(scope, job, { atoms: [] }, report)).toEqual([])
  } finally {
    store.close()
  }
})

it('extracts only original closed sources, preserves exact constraints, and never repeats completed coverage', () => {
  const store = new SqliteEvidenceStore(':memory:', 'workspace')
  try {
    const captured = store.capture(scope, source)
    store.stateStore.policy(scope, policy)
    expect(store.stateStore.pending(scope, 8).map((hit) => hit.id)).toEqual(captured.evidenceIds)
    const id = store.stateStore.enqueue(scope, captured.evidenceIds, 40)
    expect(store.stateStore.enqueue(scope, captured.evidenceIds, 40)).toBe(id)
    const job = store.stateStore.claim(scope)!
    const proposal = {
      atoms: [
        { kind: 'constraint', body: 'Publishing is approved.', evidenceIds: captured.evidenceIds },
      ],
    }
    const ids = store.stateStore.publish(scope, job, proposal, report)
    expect(store.stateStore.publish(scope, job, proposal, report)).toEqual(ids)
    expect(store.stateStore.atoms(scope, 48)[0]?.body).toBe(source.text)
    expect(store.stateStore.pending(scope, 8)).toEqual([])
    expect(store.stateStore.claim(scope)).toBeUndefined()
    expect(store.stateStore.atoms({ ...scope, sessionId: 'other' }, 48)).toEqual([])
  } finally {
    store.close()
  }
})

it('invalidates memory and extraction publication after source deletion', () => {
  const store = new SqliteEvidenceStore(':memory:', 'workspace')
  try {
    const captured = store.capture(scope, source)
    store.stateStore.policy(scope, policy)
    store.stateStore.enqueue(scope, captured.evidenceIds, 40)
    const job = store.stateStore.claim(scope)!
    const proposal = {
      atoms: [
        { kind: 'constraint', body: 'The original condition', evidenceIds: captured.evidenceIds },
      ],
    }
    store.stateStore.publish(scope, job, proposal, report)
    const before = store.stateStore.state(scope)
    store.delete(scope, source.id)
    expect(store.stateStore.state(scope).revision).toBeGreaterThan(before.revision)
    expect(store.stateStore.atoms(scope, 48)).toEqual([])
    const next = store.capture(scope, { ...source, id: 'second' })
    store.stateStore.enqueue(scope, next.evidenceIds, 40)
    const pending = store.stateStore.claim(scope)!
    store.delete(scope, 'second')
    expect(() => store.stateStore.publish(scope, pending, proposal, report)).toThrow('stale')
  } finally {
    store.close()
  }
})

it('rejects stale controls and late model output without creating approvals or overwriting current controls', () => {
  const store = new SqliteEvidenceStore(':memory:', 'workspace')
  try {
    const captured = store.capture(scope, source)
    store.stateStore.policy(scope, policy)
    store.stateStore.enqueue(scope, captured.evidenceIds, 40)
    const job = store.stateStore.claim(scope)!
    store.stateStore.controls(scope, 0, [
      { id: 'pin', kind: 'pin', role: 'user', text: 'Do not publish.' },
    ])
    expect(() => store.stateStore.controls(scope, 0, [])).toThrow('revision')
    expect(() => store.stateStore.publish(scope, job, { atoms: [] }, report)).toThrow('stale')
    expect(store.stateStore.state(scope).controlRevision).toBe(1)
    expect(store.stateStore.atoms(scope, 48)).toEqual([])
  } finally {
    store.close()
  }
})

it('allows one retry and gates extraction on approved egress and monetary reservations', () => {
  const store = new SqliteEvidenceStore(':memory:', 'workspace')
  try {
    const captured = store.capture(scope, source)
    expect(() => store.stateStore.enqueue(scope, captured.evidenceIds, 40)).toThrow('approved')
    store.stateStore.policy(scope, policy)
    store.stateStore.enqueue(scope, captured.evidenceIds, 40)
    const first = store.stateStore.claim(scope)!
    store.stateStore.gap(scope, first, { unknownBilling: true, gap: 'transport' }, true)
    const second = store.stateStore.claim(scope)!
    expect(second.attempt).toBe(2)
    store.stateStore.gap(scope, second, { unknownBilling: true, gap: 'transport' }, true)
    expect(store.stateStore.claim(scope)).toBeUndefined()
    const other = store.capture(scope, { ...source, id: 'expensive' })
    store.stateStore.policy(scope, { ...policy, budgetUsd: 0 })
    store.stateStore.enqueue(scope, other.evidenceIds, 40)
    expect(store.stateStore.claim(scope)).toBeUndefined()
    const open = store.capture(scope, {
      ...source,
      id: 'open',
      group: 'pending-tool',
      closed: false,
    })
    expect(() => store.stateStore.enqueue(scope, open.evidenceIds, 40)).toThrow('closed')
    store.stateStore.seal(scope, 'pending-tool')
    expect(store.stateStore.enqueue(scope, open.evidenceIds, 40)).toBeTruthy()
  } finally {
    store.close()
  }
})

it('stores self-contained request manifests and refuses publication under a changed source head', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-manifest-'))
  const path = join(dir, 'evidence.sqlite')
  let store = new SqliteEvidenceStore(path, 'workspace')
  try {
    const captured = store.capture(scope, source)
    const input: ManifestInput = {
      request: requestRecipe(source.text, [
        {
          value: source.text,
          ids: captured.evidenceIds,
          startByte: 0,
          endByte: Buffer.byteLength(source.text),
          encoding: 'text',
        },
      ]),
      state: store.stateStore.state(scope),
      selected: [{ id: source.id, mode: 'original', evidenceIds: captured.evidenceIds }],
      atomIds: [],
      requestHash: createHash('sha256').update(JSON.stringify(source.text)).digest('hex'),
      inputTokens: 40,
      rendererVersion: '1',
      adapterVersion: 'fixture/1',
    }
    const manifest = store.stateStore.manifest(scope, input)
    store.close()
    store = new SqliteEvidenceStore(path, 'workspace')
    expect(store.stateStore.replay(scope, manifest.id)).toEqual(manifest)
    expect(store.stateStore.replayRequest(scope, manifest.id)).toBe(source.text)
    expect(() => store.stateStore.replay({ ...scope, sessionId: 'other' }, manifest.id)).toThrow(
      'unavailable',
    )
    store.capture(scope, { ...source, id: 'later' })
    expect(() => store.stateStore.manifest(scope, input)).toThrow('changed')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('recovers an interrupted extraction attempt after restart with its reservation and retry count intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-extraction-restart-'))
  const path = join(dir, 'evidence.sqlite')
  let store = new SqliteEvidenceStore(path, 'workspace')
  try {
    const captured = store.capture(scope, source)
    store.stateStore.policy(scope, policy)
    store.stateStore.enqueue(scope, captured.evidenceIds, 40)
    expect(store.stateStore.claim(scope)?.attempt).toBe(1)
    store.close()
    store = new SqliteEvidenceStore(path, 'workspace')
    expect(store.stateStore.claim(scope)?.attempt).toBe(2)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it("retains an atom's captured provenance after new sources arrive and the database restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-atom-provenance-')),
    path = join(dir, 'evidence.sqlite')
  let store = new SqliteEvidenceStore(path, 'workspace')
  try {
    const captured = store.capture(scope, source)
    store.stateStore.policy(scope, policy)
    store.stateStore.enqueue(scope, captured.evidenceIds, 40)
    const job = store.stateStore.claim(scope)!
    store.capture(scope, { ...source, id: 'later', text: 'A newer observation.' })
    store.stateStore.publish(
      scope,
      job,
      {
        atoms: [
          { kind: 'constraint', body: 'Incorrect paraphrase', evidenceIds: captured.evidenceIds },
        ],
      },
      report,
    )
    const before = store.stateStore.atoms(scope, 48)[0]!
    expect(before.derivation).toMatchObject({
      provider: job.provider,
      model: job.model,
      sourceHead: job.state.head,
      sourceRevision: job.state.revision,
      controlRevision: job.state.controlRevision,
      instructionHash: job.instructionHash,
      extractorVersion: job.extractorVersion,
      schemaVersion: 2,
    })
    expect(before.derivation.sourceHead).toBeLessThan(store.stateStore.state(scope).head)
    store.close()
    store = new SqliteEvidenceStore(path, 'workspace')
    expect(store.stateStore.atoms(scope, 48)[0]).toEqual(before)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('assigns a new job identity after a control revision changes for the same source window', () => {
  const store = new SqliteEvidenceStore(':memory:', 'workspace')
  try {
    const captured = store.capture(scope, source)
    store.stateStore.policy(scope, policy)
    const first = store.stateStore.enqueue(scope, captured.evidenceIds, 40)
    store.stateStore.controls(scope, 0, [
      { id: 'pin', kind: 'pin', role: 'user', text: 'Keep this exact instruction.' },
    ])
    expect(store.stateStore.enqueue(scope, captured.evidenceIds, 40)).not.toBe(first)
  } finally {
    store.close()
  }
})
