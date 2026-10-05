import { expect, it, vi } from 'vitest'
import { EvidenceExtractor, type ExtractionAdapter, ExtractionFailure } from '../src/extract.ts'
import { EvidenceStore } from '../src/index.ts'

const scope = { workspaceId: 'workspace', sessionId: 'session' }
const worker = new URL('../lib/worker.js', import.meta.url)
const archive = new URL('../lib/archive-worker.js', import.meta.url)
async function setup() {
  const store = new EvidenceStore(':memory:', 'workspace', worker, archive)
  await store.policy(scope, {
    enabled: true,
    provider: 'fixture',
    model: 'operator-model',
    promptVersion: '1',
    budgetUsd: 1,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
    allowUnknownBilling: false,
  })
  await store.capture(scope, {
    id: 'source',
    role: 'user',
    group: 'closed',
    closed: true,
    text: 'Never publish unless I explicitly approve.',
  })
  return store
}

it('sends original evidence without action tools and uses the operator-selected route', async () => {
  const store = await setup()
  const run = vi.fn<ExtractionAdapter['run']>(async (input) => ({
    payload: {
      atoms: [
        {
          kind: 'constraint',
          body: 'Approval inferred',
          evidenceIds: input.evidence.map((source) => source.id),
        },
      ],
    },
    report: { inputTokens: 4000, outputTokens: 20, costUsd: 0.004, unknownBilling: false },
  }))
  try {
    const extractor = new EvidenceExtractor(store, scope, { count: () => 4000, run })
    await extractor.maintain(new AbortController().signal)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      provider: 'fixture',
      model: 'operator-model',
      tools: [],
      maxOutputTokens: 1500,
    })
    expect((await store.atoms(scope))[0]?.body).toBe('Never publish unless I explicitly approve.')
    await extractor.maintain(new AbortController().signal)
    expect(run).toHaveBeenCalledTimes(1)
    expect(await store.diagnostics(scope)).toMatchObject({ complete: 1, gaps: 0 })
  } finally {
    await store.close()
  }
})

it('limits transient failures to two billed attempts and reports a deterministic coverage gap', async () => {
  const store = await setup()
  const run = vi.fn<ExtractionAdapter['run']>(async () => {
    throw new ExtractionFailure(true)
  })
  try {
    const extractor = new EvidenceExtractor(store, scope, { count: () => 4000, run })
    for (let i = 0; i < 3; i++) await extractor.maintain(new AbortController().signal)
    expect(run).toHaveBeenCalledTimes(2)
    expect(await store.diagnostics(scope)).toMatchObject({ gaps: 1, unknownBillingAttempts: 2 })
    expect(await store.search(scope, 'approve')).toHaveLength(1)
  } finally {
    await store.close()
  }
})

it('does not publish late output under changed controls and rejects model action calls', async () => {
  const store = await setup()
  try {
    const run: ExtractionAdapter['run'] = async () => {
      await store.controls(scope, 0, [
        { id: 'pin', kind: 'pin', role: 'user', text: 'No approval has been given.' },
      ])
      return { payload: { atoms: [] }, report: { unknownBilling: true } }
    }
    await new EvidenceExtractor(store, scope, { count: () => 4000, run }).maintain(
      new AbortController().signal,
    )
    expect(await store.atoms(scope)).toEqual([])
    expect(await store.readControls(scope)).toEqual([
      { id: 'pin', kind: 'pin', role: 'user', text: 'No approval has been given.' },
    ])
    await store.policy(scope, {
      enabled: true,
      provider: 'fixture',
      model: 'different-model',
      promptVersion: '2',
      budgetUsd: 1,
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
      allowUnknownBilling: false,
    })
    await new EvidenceExtractor(store, scope, {
      count: () => 4000,
      run: async () => ({
        payload: { atoms: [] },
        toolCalls: true,
        report: { unknownBilling: true },
      }),
    }).maintain(new AbortController().signal)
    expect(await store.atoms(scope)).toEqual([])
    expect((await store.diagnostics(scope)).gaps).toBe(2)
  } finally {
    await store.close()
  }
})

it('cancels a non-cooperative extractor without blocking source retrieval', async () => {
  const store = await setup()
  const abort = new AbortController()
  const entered = Promise.withResolvers<void>()
  try {
    const extractor = new EvidenceExtractor(store, scope, {
      count: () => 4000,
      run: () => {
        entered.resolve()
        return new Promise(() => {})
      },
    })
    const pending = extractor.maintain(abort.signal)
    await entered.promise
    expect(await store.search(scope, 'approve')).toHaveLength(1)
    abort.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
    expect((await store.diagnostics(scope)).gaps).toBe(1)
  } finally {
    await store.close()
  }
})
