import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import {
  decideAction,
  type EvidenceContract,
  type EvidenceReceipt,
  evaluateEvidence,
  fingerprint,
  LeaseJournal,
  resolveConfiguration,
} from '../src/index.ts'

it('resolves an explicit chain with provenance and rejects unauthorized run overrides', () => {
  const result = resolveConfiguration(
    {
      defaults: { limit: 10, tools: ['read'] },
      environment: { limit: 5 },
      user: { tools: ['read', 'verify'] },
      run: { limit: 2 },
    },
    { keys: ['limit', 'tools'], runKeys: ['limit'], validate: (value) => value },
  )
  expect(result.value).toEqual({ limit: 2, tools: ['read', 'verify'] })
  expect(result.provenance).toEqual({ limit: 'run', tools: 'user' })
  expect(Object.isFrozen(result.value.tools)).toBe(true)
  expect(() =>
    resolveConfiguration(
      { run: { tools: ['publish'] } },
      { keys: ['tools'], runKeys: [], validate: (value) => value },
    ),
  ).toThrow('not admitted')
  expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }))
  expect(() => fingerprint(JSON.parse('{"__proto__":{}}'))).toThrow('Reserved')
})
const contract: EvidenceContract = {
  id: 'release',
  minimumIndependentSources: 2,
  freshnessMs: 1000,
  requireDatabaseRead: true,
  verifiers: ['tests'],
  requireModelVerifier: true,
  requireHumanReview: false,
}
const receipt = (
  id: string,
  kind: EvidenceReceipt['kind'],
  origin = id,
  hash = id,
): EvidenceReceipt => ({
  id,
  target: 'target',
  kind,
  origin,
  contentHash: hash,
  recordedAt: 100,
  passed: true,
  ...(kind === 'verifier' ? { verifierId: 'tests' } : {}),
})
it('requires independent, fresh, target-bound evidence and separates model opinion from verification', () => {
  const initial = [
    receipt('a', 'source', 'publisher'),
    receipt('b', 'source', 'publisher'),
    receipt('c', 'source', 'mirror', 'a'),
    receipt('db', 'database-read'),
    receipt('v', 'verifier'),
    receipt('m', 'model-verifier'),
  ]
  expect(evaluateEvidence(contract, initial, 'target', 200).state).toBe('insufficient_evidence')
  const eligible = [...initial, receipt('independent', 'source')]
  expect(evaluateEvidence(contract, eligible, 'target', 200).state).toBe('verified')
  expect(evaluateEvidence(contract, eligible, 'changed-target', 200).state).toBe(
    'insufficient_evidence',
  )
  expect(evaluateEvidence(contract, eligible, 'target', 1200).state).toBe('insufficient_evidence')
  expect(
    evaluateEvidence(
      { ...contract, minimumIndependentSources: 0, requireDatabaseRead: false, verifiers: [] },
      [receipt('m', 'model-verifier')],
      'target',
      200,
    ).state,
  ).toBe('unverified')
})
it('cannot promote an allow rule or model answer over a deny or missing evidence', () => {
  const action = {
    tool: 'publish',
    arguments: { target: 'release' },
    environment: 'prod' as const,
    sessionId: 'session',
    target: 'target',
  }
  const rules = [
    {
      id: 'admit',
      tools: ['*'],
      environments: ['prod' as const],
      effect: 'allow' as const,
      evidenceContract: 'release',
    },
    {
      id: 'no-publish',
      tools: ['publish'],
      environments: ['prod' as const],
      effect: 'deny' as const,
    },
  ]
  expect(
    decideAction(action, rules, 'deny', () => ({ state: 'verified', missing: [], receiptIds: [] }))
      .reason?.kind,
  ).toBe('missing_permissions')
  expect(
    decideAction(action, rules.slice(0, 1), 'deny', () => ({
      state: 'unverified',
      missing: [],
      receiptIds: [],
    })).reason?.kind,
  ).toBe('missing_evidence')
  expect(
    decideAction({ ...action, environment: 'dev' }, rules, 'require_review', () => ({
      state: 'verified',
      missing: [],
      receiptIds: [],
    })).effect,
  ).toBe('require_review')
})
it('reclaims expired leases and fences results from a crashed worker', () => {
  const db = new Database(':memory:')
  try {
    const journal = new LeaseJournal(db)
    journal.submit(
      {
        id: 'job',
        scope: 'dev/session',
        kind: 'verify',
        payload: { ref: 'target' },
        maxAttempts: 2,
        retrySafe: true,
      },
      0,
    )
    const first = journal.claim('dev/session', 1000, 0)!
    expect(journal.claim('dev/session', 1000, 999)).toBeUndefined()
    const next = journal.claim('dev/session', 1000, 1000)!
    expect(next.token).not.toBe(first.token)
    expect(next.job.attempts).toBe(2)
    expect(() => journal.complete('job', first.token, { passed: true }, 1001)).toThrow('replaced')
    journal.complete('job', next.token, { passed: true }, 1001)
    expect(journal.get('job')?.status).toBe('complete')
  } finally {
    db.close()
  }
})
it('moves exhausted and uncertain side effects into inspectable dead letters', () => {
  const db = new Database(':memory:')
  try {
    const journal = new LeaseJournal(db)
    journal.submit(
      {
        id: 'side-effect',
        scope: 'prod/session',
        kind: 'publish',
        payload: { ref: 'target' },
        maxAttempts: 2,
        retrySafe: false,
      },
      0,
    )
    journal.claim('prod/session', 1000, 0)
    expect(journal.claim('prod/session', 1000, 1000)).toBeUndefined()
    expect(journal.inspect('prod/session', 'dead')[0]?.reason).toContain('unknown')
    expect(() => journal.retry('side-effect', 'prod/session', false, 1001)).toThrow(
      'reconciliation',
    )
    journal.retry('side-effect', 'prod/session', true, 1001)
    const next = journal.claim('prod/session', 1000, 1001)!
    journal.fail('side-effect', next.token, 'Controlled transient failure', true, 10, 1002)
    expect(journal.get('side-effect')?.status).toBe('dead')
    expect(() => journal.retry('side-effect', 'prod/session', true, 1003)).toThrow(
      'available attempt',
    )
    expect(() =>
      journal.submit(
        {
          id: 'side-effect',
          scope: 'prod/session',
          kind: 'publish',
          payload: { ref: 'other' },
          maxAttempts: 2,
          retrySafe: false,
        },
        1003,
      ),
    ).toThrow('another operation')
  } finally {
    db.close()
  }
})
