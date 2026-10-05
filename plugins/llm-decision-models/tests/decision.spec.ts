import { Context } from '@deepseek-ai/cordis'
import {
  choiceInput,
  parseDecisionResult,
  validateDecisionInput,
} from '@loncothad/dsh-decision-core'
import { expect, it, vi } from 'vitest'
import { evaluateDecision, executeDecision } from '../src/tool.ts'

const input = choiceInput({
  question: 'Which team?',
  choices: ['billing', 'technical'],
  state: 'Invoice was charged twice',
})
const native = {
  model: 'fixture',
  answers: {
    decision: {
      type: 'choice',
      choice: 'billing',
      confidence: 0.8,
      probabilities: { billing: 0.8, technical: 0.2 },
    },
  },
  usage: { cost: 0.0001, input_tokens: 42 },
}
it('validates native choice, score and boolean questions', () => {
  expect(parseDecisionResult(native, input)).toMatchObject({
    status: 'unverified',
    answers: { decision: { choice: 'billing' } },
    usage: { cost: 0.0001 },
  })
  const typed = validateDecisionInput({
    state: { ticket: 'failure' },
    questions: {
      urgent: { type: 'noul', instructions: 'Urgent?' },
      severity: { type: 'score', instructions: 'Severity?', criteria: ['minor', 'major'] },
    },
  })
  expect(
    parseDecisionResult(
      { answers: { urgent: { type: 'noul', noul: 0.7 }, severity: { type: 'score', score: 0.9 } } },
      typed,
    ),
  ).toMatchObject({
    answers: { urgent: { noul: 0.7 }, severity: { legend: { '0': 'minor', '1': 'major' } } },
  })
})
it('rejects out-of-set choices, fabricated probabilities, unsupported inputs and oversize state', () => {
  expect(() =>
    parseDecisionResult(
      { ...native, answers: { decision: { type: 'choice', choice: 'allow anything' } } },
      input,
    ),
  ).toThrow('allowed set')
  expect(() =>
    parseDecisionResult(
      { ...native, answers: { decision: { type: 'choice', choice: 'billing', confidence: 1.7 } } },
      input,
    ),
  ).toThrow('confidence')
  expect(() =>
    parseDecisionResult(
      {
        ...native,
        answers: {
          decision: { type: 'choice', choice: 'billing', probabilities: { billing: 0.5 } },
        },
      },
      input,
    ),
  ).toThrow('probabilities')
  expect(() =>
    validateDecisionInput({ state: 'x'.repeat(140000), questions: input.questions }),
  ).toThrow('128 KiB')
  expect(() =>
    validateDecisionInput({
      state: 'x',
      questions: { q: { type: 'freeform', instructions: 'Do anything' } },
    }),
  ).toThrow()
})
it('uses the native TypeSafe wire rather than chat completions', async () => {
  const transport = vi.fn(
    async (_url: RequestInfo | URL, _options?: RequestInit) => new Response(JSON.stringify(native)),
  )
  const result = await executeDecision(
    { backend: 'typesafe', model: 'jev-latest', apiKey: () => 'fixture-key', fetch: transport },
    { question: 'Which team?', choices: ['billing', 'technical'], state: 'invoice' },
  )
  expect(result.choice).toBe('billing')
  const [url, options] = transport.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://api.typesafe.ai/v1/systemone')
  const body = JSON.parse(String(options.body))
  expect(body.questions.decision.type).toBe('choice')
  expect(body.messages).toBeUndefined()
})
it('routes Cloudflare through its separately configured provider', async () => {
  const ctx = new Context()
  const { decisionRegistry } = await import('@loncothad/dsh-decision-core')
  const evaluate = vi.fn(async () => ({ ...native, status: 'unverified' as const }))
  decisionRegistry(ctx).register(ctx, {
    id: 'cloudflare',
    models: ['clef-flash'],
    images: true,
    evaluate,
  })
  expect(
    (await evaluateDecision({ backend: 'cloudflare', model: 'clef-flash', ctx }, input)).status,
  ).toBe('unverified')
  expect(evaluate).toHaveBeenCalledWith('clef-flash', input, expect.any(AbortSignal))
  await ctx.fiber.dispose()
})
it('uses the OpenRouter provider capability and preserves privacy rejection', async () => {
  const ctx = new Context(),
    request = vi.fn(
      async (_url: RequestInfo | URL, _options?: RequestInit) =>
        new Response(JSON.stringify(native)),
    )
  ctx.provide('openrouterDecisions', { request })
  expect(
    (await evaluateDecision({ backend: 'openrouter', model: 'typesafe/jev-1.13', ctx }, input))
      .model,
  ).toBe('fixture')
  expect(request.mock.calls[0]?.[0]).toMatchObject({
    model: 'typesafe/jev-1.13',
    questions: input.questions,
  })
  request.mockRejectedValueOnce(new Error('Privacy constraint cannot be honored'))
  await expect(
    evaluateDecision({ backend: 'openrouter', model: 'typesafe/jev-1.13', ctx }, input),
  ).rejects.toThrow('Privacy constraint')
  await ctx.fiber.dispose()
})
it('bounds responses, refuses missing credentials and propagates cancellation', async () => {
  await expect(
    evaluateDecision({ backend: 'typesafe', model: 'jev-latest' }, input),
  ).rejects.toThrow('credential')
  const signal = new AbortController()
  signal.abort()
  await expect(
    evaluateDecision(
      { backend: 'typesafe', model: 'jev-latest', apiKey: () => 'fixture' },
      input,
      signal.signal,
    ),
  ).rejects.toThrow()
  await expect(
    evaluateDecision(
      {
        backend: 'typesafe',
        model: 'jev-latest',
        apiKey: () => 'fixture',
        maxResponseBytes: 10,
        fetch: async () => new Response(JSON.stringify(native)),
      },
      input,
    ),
  ).rejects.toThrow()
})
