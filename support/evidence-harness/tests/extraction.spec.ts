import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { EvidenceHit, ExtractionInput } from '@loncothad/dsh-evidence-store'
import {
  EvidenceExtractor,
  EvidenceStore,
  EXTRACTOR_INSTRUCTION,
  ExtractionFailure,
} from '@loncothad/dsh-evidence-store'
import { expect, it, vi } from 'vitest'
import { extractionOutput, extractionTokens, NativeExtractionAdapter } from '../src/index.ts'

const signal = new AbortController().signal
const source: EvidenceHit = {
  id: 1,
  eventId: 'original',
  objectId: 'hash',
  startByte: 0,
  endByte: 10,
  quote: 'Do not deploy unless I approve.',
  role: 'user',
  seq: 1,
}
const input: ExtractionInput = {
  provider: 'fixture',
  model: 'operator-selected-model',
  instruction: EXTRACTOR_INSTRUCTION,
  evidence: [source],
  tools: [],
  maxOutputTokens: 1500,
}
async function* stream(chunks: StreamChunk[]) {
  yield* chunks
}
const json = '{"atoms":[]}'
const success: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: json },
  { type: 'block-end', index: 0, block: { type: 'text', text: json } },
  { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 9 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

class Provider extends LlmAdapter {
  requests: GenerateOptions[] = []
  window: number | undefined = 32_000
  chunks = success
  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      ...(this.window !== undefined ? { context: { contextWindow: this.window } } : {}),
    }
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    yield* this.chunks
  }
}
async function harness() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const provider = new Provider()
  ctx.llm.registerAdapter(['fixture'], provider)
  return { ctx, provider }
}

it('dispatches through the real native runtime with the exact operator route, original evidence, and no tools', async () => {
  const { ctx, provider } = await harness()
  const authorize = vi.fn(async () => {})
  try {
    const adapter = new NativeExtractionAdapter(ctx.llm, { authorize })
    expect(await adapter.run(input, signal)).toEqual({
      payload: json,
      report: { inputTokens: 120, outputTokens: 9, unknownBilling: false },
    })
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0]).toMatchObject({
      provider: 'fixture',
      model: 'operator-selected-model',
      tools: [],
      maxTokens: 1500,
      purpose: 'compaction',
      system: EXTRACTOR_INSTRUCTION,
    })
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain(
      'Do not deploy unless I approve.',
    )
    expect(extractionTokens([source])).toBeGreaterThan(Math.ceil(source.quote.length / 4))
  } finally {
    await ctx.fiber.dispose()
  }
})

it('checks policy again after model lookup and never dispatches revoked evidence', async () => {
  const { ctx, provider } = await harness()
  let checks = 0
  try {
    const adapter = new NativeExtractionAdapter(ctx.llm, {
      authorize: async () => {
        if (++checks === 2) throw new Error('policy changed')
      },
    })
    await expect(adapter.run(input, signal)).rejects.toThrow('policy changed')
    expect(provider.requests).toEqual([])
    provider.window = 100
    await expect(
      new NativeExtractionAdapter(ctx.llm, { authorize: async () => {} }).run(input, signal),
    ).rejects.toThrow('capacity')
    expect(provider.requests).toEqual([])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('supports complete native text blocks without deltas and rejects replacement of delivered deltas', async () => {
  const noDeltas = [success[0]!, success[2]!, success[4]!]
  expect((await extractionOutput(stream(noDeltas), signal)).payload).toBe(json)
  const bad: StreamChunk[] = [...success]
  bad[2] = { type: 'block-end', index: 0, block: { type: 'text', text: '{"atoms":["invented"]}' } }
  await expect(extractionOutput(stream(bad), signal)).rejects.toThrow('closure')
})

it('rejects action blocks, missing/duplicate terminal records, and truncated output', async () => {
  await expect(
    extractionOutput(stream([{ type: 'block-start', index: 0, blockType: 'tool-call' }]), signal),
  ).rejects.toThrow('block')
  await expect(extractionOutput(stream(success.slice(0, -1)), signal)).rejects.toThrow('terminal')
  await expect(extractionOutput(stream([...success, success.at(-1)!]), signal)).rejects.toThrow(
    'stream',
  )
  await expect(
    extractionOutput(
      stream([...success.slice(0, -1), { type: 'finish', reason: { kind: 'max-tokens' } }]),
      signal,
    ),
  ).rejects.toThrow('successfully')
})

it('bounds reasoning as well as text and distinguishes retryable native failures', async () => {
  await expect(
    extractionOutput(
      stream([
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: '🪼'.repeat(17_000) },
      ]),
      signal,
    ),
  ).rejects.toThrow('oversized')
  await expect(
    extractionOutput(
      stream([
        {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: 'private provider body', code: 'RATE_LIMIT', status: 429 },
          },
        },
      ]),
      signal,
    ),
  ).rejects.toMatchObject({ retryable: true, status: 429, message: 'Extraction failed (HTTP 429)' })
  await expect(
    extractionOutput(
      stream([
        {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'key secret', code: 'AUTH', status: 401 } },
        },
      ]),
      signal,
    ),
  ).rejects.toMatchObject({ retryable: false })
  expect(new ExtractionFailure(true).message).not.toContain('secret')
})

it('connects worker-owned original coverage to native extraction without promoting an inferred approval', async () => {
  const { ctx, provider } = await harness()
  const store = new EvidenceStore(
    ':memory:',
    'workspace',
    new URL('../../evidence-store/lib/worker.js', import.meta.url),
  )
  const scope = { workspaceId: 'workspace', sessionId: 'session' }
  try {
    const result = await store.capture(scope, {
      id: 'native-user',
      role: 'user',
      group: 'turn:1',
      closed: true,
      text: source.quote,
    })
    await store.policy(scope, {
      enabled: true,
      provider: 'fixture',
      model: 'operator-selected-model',
      promptVersion: '1',
      budgetUsd: 1,
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
      allowUnknownBilling: false,
    })
    const payload = JSON.stringify({
      atoms: [
        {
          kind: 'constraint',
          body: 'The user approved deployment.',
          evidenceIds: result.evidenceIds,
        },
      ],
    })
    provider.chunks = [
      success[0]!,
      { type: 'block-end', index: 0, block: { type: 'text', text: payload } },
      success[3]!,
      success[4]!,
    ]
    const adapter = new NativeExtractionAdapter(ctx.llm, {
      authorize: async (request) => {
        expect(request.model).toBe('operator-selected-model')
      },
    })
    const extractor = new EvidenceExtractor(store, scope, adapter)
    await extractor.maintain(signal, { threshold: 1 })
    expect((await store.atoms(scope))[0]).toMatchObject({
      body: source.quote,
      exact: true,
      roles: ['user'],
    })
    await extractor.maintain(signal, { threshold: 1 })
    expect(provider.requests).toHaveLength(1)
    expect(await store.diagnostics(scope)).toMatchObject({ complete: 1, gaps: 0 })
  } finally {
    await store.close()
    await ctx.fiber.dispose()
  }
})

it('requires explicit capacity for an unknown extraction route and never overrides advertised capacity', async () => {
  const { ctx, provider } = await harness()
  try {
    provider.window = undefined
    await expect(
      new NativeExtractionAdapter(ctx.llm, { authorize: async () => {} }).run(input, signal),
    ).rejects.toThrow('explicit extraction fallback')
    expect(provider.requests).toEqual([])
    await expect(
      new NativeExtractionAdapter(ctx.llm, {
        authorize: async () => {},
        fallbackContextWindow: 32000,
      }).run(input, signal),
    ).resolves.toMatchObject({ payload: json })
    provider.requests = []
    provider.window = 1600
    await expect(
      new NativeExtractionAdapter(ctx.llm, {
        authorize: async () => {},
        fallbackContextWindow: 32000,
      }).run(input, signal),
    ).rejects.toThrow('insufficient input capacity')
    expect(provider.requests).toEqual([])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('counts UTF-8 evidence and the exact prepared envelope before dispatch', async () => {
  const { ctx, provider } = await harness()
  try {
    const unicode = { ...source, quote: '🪼'.repeat(2000) }
    expect(extractionTokens([unicode])).toBeGreaterThan(2600)
    const request = { ...input, evidence: [unicode] }
    provider.window = 4500
    await expect(
      new NativeExtractionAdapter(ctx.llm, { authorize: async () => {}, safetyTokens: 512 }).run(
        request,
        signal,
      ),
    ).rejects.toThrow('insufficient input capacity')
    expect(provider.requests).toEqual([])
    provider.window = 32000
    const oversizedRoute = { ...input, model: 'm'.repeat(30000) }
    await expect(
      new NativeExtractionAdapter(ctx.llm, { authorize: async () => {} }).run(
        oversizedRoute,
        signal,
      ),
    ).rejects.toThrow('insufficient input capacity')
    expect(provider.requests).toEqual([])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('records a bounded extraction gap for unknown capacity while retaining original evidence', async () => {
  const { ctx, provider } = await harness()
  const store = new EvidenceStore(
    ':memory:',
    'workspace',
    new URL('../../evidence-store/lib/worker.js', import.meta.url),
  )
  const scope = { workspaceId: 'workspace', sessionId: 'capacity-gap' }
  try {
    provider.window = undefined
    const captured = await store.capture(scope, {
      id: 'original-user',
      role: 'user',
      group: 'turn:1',
      closed: true,
      text: source.quote,
    })
    await store.policy(scope, {
      enabled: true,
      provider: 'fixture',
      model: input.model,
      promptVersion: '1',
      budgetUsd: 1,
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
      allowUnknownBilling: false,
    })
    const extractor = new EvidenceExtractor(
      store,
      scope,
      new NativeExtractionAdapter(ctx.llm, { authorize: async () => {} }),
    )
    await extractor.maintain(signal, { threshold: 1 })
    expect(provider.requests).toEqual([])
    expect(await store.diagnostics(scope)).toMatchObject({ gaps: 1, complete: 0 })
    expect(await store.atoms(scope)).toEqual([])
    expect((await store.read(scope, captured.evidenceIds))[0]?.quote).toBe(source.quote)
    await extractor.maintain(signal, { threshold: 1 })
    expect(await store.diagnostics(scope)).toMatchObject({ gaps: 1 })
    expect(provider.requests).toEqual([])
  } finally {
    await store.close()
    await ctx.fiber.dispose()
  }
})
