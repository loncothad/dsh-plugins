import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { resolvePolicy } from '../src/config.ts'
import { type Evidence, hash } from '../src/domain.ts'
import { reservation, review } from '../src/review.ts'

it('requires explicit pricing or an unknown-billing reservation and refuses insufficient budget before inference', async () => {
  expect(() => reservation(resolvePolicy({}), 100, 2)).toThrow('prices')
  expect(reservation(resolvePolicy({ allowUnknownBilling: true }), 100, 2)).toBe(2)
  const stream = vi.fn(),
    ctx = {
      llm: {
        prepareCall: async () => ({
          config: { maxTokens: 2048 },
          context: { contextWindow: 128000 },
          stream,
        }),
      },
    } as unknown as Context
  const row: Evidence = {
    id: 'root:1',
    sessionId: 'root',
    seq: 1,
    hash: hash('claim'),
    text: 'claim',
    truncated: false,
    kind: 'assistant/message',
  }
  const reserve = vi.fn()
  await expect(
    review(
      ctx,
      resolvePolicy({
        reviewerProvider: 'fixture',
        reviewerModel: 'reviewer',
        inputUsdPerMillion: 1000,
        outputUsdPerMillion: 1000,
      }),
      [row],
      new AbortController().signal,
      reserve,
      0.001,
    ),
  ).rejects.toThrow('budget')
  expect(reserve).not.toHaveBeenCalled()
  expect(stream).not.toHaveBeenCalled()
})

it('uses a standalone tool-free review prompt and rejects fabricated source IDs', async () => {
  const row: Evidence = {
    id: 'child:7',
    sessionId: 'child',
    seq: 7,
    hash: hash('tests skipped'),
    text: 'tests skipped',
    truncated: false,
    kind: 'assistant/message',
  }
  let request: Record<string, unknown> | undefined
  const ctx = {
    llm: {
      prepareCall: async () => ({
        config: { maxTokens: 2048 },
        context: { contextWindow: 128000 },
        async *stream(value: Record<string, unknown>) {
          request = value
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'text',
              text: JSON.stringify({
                findings: [
                  {
                    title: 'Missing verifier',
                    severity: 'warning',
                    category: 'verification',
                    detail: 'Check the test result.',
                    nextAction: 'Run tests.',
                    sourceIds: ['child:7'],
                  },
                ],
              }),
            },
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
  } as unknown as Context
  const reserve = vi.fn(async () => {}),
    result = await review(
      ctx,
      resolvePolicy({
        reviewerProvider: 'fixture',
        reviewerModel: 'reviewer',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
      }),
      [row],
      new AbortController().signal,
      reserve,
      2,
    )
  expect(result[0]?.sources[0]?.reference).toBe('child:7')
  expect(request?.tools).toEqual([])
  expect(request?.system).toContain('untrusted data')
  expect(request?.messages).toHaveLength(1)
  expect(reserve).toHaveBeenCalledOnce()
})
