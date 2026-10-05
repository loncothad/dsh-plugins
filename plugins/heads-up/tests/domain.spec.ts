import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { type SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import {
  collect,
  type Evidence,
  hash,
  initial,
  localFindings,
  parseReview,
  publish,
  redact,
  stateSchema,
} from '../src/domain.ts'

const evidence = (text: string): Evidence => ({
  id: 'child:12',
  sessionId: 'child',
  seq: 12,
  hash: hash(text),
  text,
  truncated: false,
  kind: 'assistant/message',
})
it('reports missing verification and test weakening as source-linked review cues, never intent', () => {
  for (const text of [
    'Tests were not run.',
    '{"file":"tests/export.spec.ts","patch":"-expect(output).toEqual(original)\\n+test.skip("check",()=>{})"}',
    'A payment call retries when silent.',
  ]) {
    const findings = localFindings([evidence(text)])
    expect(findings).toHaveLength(1)
    expect(findings[0]?.sources[0]).toMatchObject({
      sessionId: 'child',
      seq: 12,
      kind: 'session',
      reference: 'child:12',
    })
    expect(findings[0]?.detail).not.toContain('cheating')
  }
  expect(localFindings([evidence('All checks passed; the verifier receipt is attached.')])).toEqual(
    [],
  )
  expect(localFindings([evidence('Payment retries use the same idempotency key.')])).toEqual([])
})
it('rejects uncited or unavailable model concerns and keeps valid reviewer output unverified', () => {
  const row = {
    title: 'A hidden risk',
    severity: 'warning',
    category: 'verification',
    detail: 'Inspect the missing verifier.',
    nextAction: 'Run the verifier',
    sourceIds: ['child:12'],
  }
  expect(
    parseReview(JSON.stringify({ findings: [row] }), [evidence('Tests were not run.')])[0]
      ?.sources[0]?.reference,
  ).toBe('child:12')
  expect(() =>
    parseReview(JSON.stringify({ findings: [{ ...row, sourceIds: ['invented'] }] }), [
      evidence('x'),
    ]),
  ).toThrow('unavailable')
  expect(() =>
    parseReview(JSON.stringify({ findings: [{ ...row, confidence: 0.99 }] }), [evidence('x')]),
  ).toThrow()
})
it('deduplicates acknowledged findings without reviving them and bounds retained state', () => {
  const finding = localFindings([evidence('Tests were not run.')])[0]!
  let state = publish(initial(), [finding], 'local', 16)
  state.notices[0]!.state = 'acknowledged'
  state = publish(state, [finding], 'local', 16)
  expect(state.notices).toHaveLength(1)
  expect(state.notices[0]?.state).toBe('acknowledged')
  const rows = Array.from({ length: 40 }, (_, i) => ({
    ...finding,
    sources: [{ ...finding.sources[0]!, hash: hash(String(i)) }],
  }))
  expect(publish(state, rows, 'model', 4).notices).toHaveLength(4)
  expect(() =>
    stateSchema.parse({
      ...state,
      streams: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [String(i), 0])),
    }),
  ).toThrow('bound')
})
it('redacts credentials, omits user/system/private events and marks bounded excerpts explicitly', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456'
  expect(redact('-----BEGIN PRIVATE KEY-----\nMII-partial-private-material')).not.toContain(
    'MII-partial-private-material',
  )
  expect(
    redact(
      JSON.stringify({
        apiKey: 'opaque-credential-value',
        headers: { authorization: 'Bearer opaque-access-token' },
      }),
    ),
  ).not.toContain('opaque-')
  expect(redact(`authorization=Bearer\napi_key=${secret}\n${secret}`)).not.toContain(secret)
  const events = [
    {
      type: 'user/message',
      seq: 0,
      data: { content: [{ type: 'text', text: 'private user instruction' }] },
    },
    { type: 'system/message', seq: 1, data: {} },
    {
      type: 'assistant/message',
      seq: 2,
      data: { message: { content: [{ type: 'text', text: `${secret}\n${'x'.repeat(4000)}` }] } },
    },
    { type: 'turn/end', seq: 3, data: {} },
  ] as SessionEvent[]
  const result = collect(events, 'root', -1, 4096, 512, true)
  expect(result.evidence).toHaveLength(1)
  expect(result.evidence[0]?.truncated).toBe(true)
  expect(result.through).toBe(3)
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(JSON.stringify(result)).not.toContain('private user instruction')
})

it('advances past oversized escaped events and preserves contiguous incremental coverage', () => {
  const event = (seq: number, text: string) =>
    ({
      type: 'assistant/message',
      time: 0,
      seq: SessionSeq(seq),
      data: {
        message: createAssistantMessage({
          source: { provider: 'fixture', model: 'main' },
          content: [{ type: 'text', text }],
        }),
      },
    }) as SessionEvent
  const events = [event(0, '\\"'.repeat(10000)), event(1, 'Tests were not run.')]
  const first = collect(events, 'root', -1, 4096, 16384, true)
  expect(JSON.stringify(first.evidence).length).toBeLessThanOrEqual(4096)
  expect(first.through).toBe(0)
  expect(first.hasMore).toBe(true)
  expect(first.evidence[0]?.truncated).toBe(true)
  const second = collect(events, 'root', first.through, 4096, 16384, true)
  expect(second.through).toBe(1)
  expect(second.hasMore).toBe(false)
  expect(localFindings(second.evidence)[0]?.category).toBe('verification')
})

it('keeps identical findings from independent subagents and separate concerns on the same source distinct', () => {
  const first = localFindings([evidence('Tests were not run.')])[0]!
  const otherChild = {
    ...first,
    sources: first.sources.map((source) => ({
      ...source,
      sessionId: 'other-child',
      reference: 'other-child:12',
    })),
  }
  const separateConcern = {
    ...first,
    title: 'Original acceptance checks are missing',
    nextAction: 'Compare the original acceptance criteria.',
  }
  const state = publish(initial(), [first, otherChild, separateConcern, first], 'model', 16)
  expect(state.notices).toHaveLength(3)
  expect(state.notices.filter((n) => n.title === first.title)).toHaveLength(2)
})
