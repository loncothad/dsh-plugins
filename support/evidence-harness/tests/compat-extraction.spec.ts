import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { EXTRACTOR_INSTRUCTION } from '@loncothad/dsh-evidence-store'
import { OpenAICompatAdapter } from '@loncothad/dsh-llm-openai-compat'
import { expect, it } from 'vitest'
import { NativeExtractionAdapter } from '../src/extraction.ts'

it('extracts through the real prepared provider and compatible wire with complete native blocks', async () => {
  const ctx = new Context(),
    requests: Record<string, unknown>[] = []
  try {
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(
      ['fixture'],
      new OpenAICompatAdapter({
        provider: 'fixture',
        endpoint: 'https://fixture.test/chat/completions',
        apiKey: () => 'fixture',
        models: [{ id: 'model', contextWindow: 20000 }],
        extraBody: () => ({ response_format: { type: 'json_object' } }),
        fetch: async (_url, init) => {
          requests.push(JSON.parse(init!.body as string))
          const text = JSON.stringify({
            atoms: [{ kind: 'constraint', body: 'Do not publish.', evidenceIds: [1] }],
          })
          return new Response(
            `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 30 } })}\n\ndata: [DONE]\n\n`,
          )
        },
      }),
    )
    const extractor = new NativeExtractionAdapter(ctx.llm, { authorize: async () => {} })
    const result = await extractor.run(
      {
        provider: 'fixture',
        model: 'model',
        instruction: EXTRACTOR_INSTRUCTION,
        tools: [],
        maxOutputTokens: 1500,
        evidence: [
          {
            id: 1,
            eventId: 'original',
            objectId: 'object',
            startByte: 0,
            endByte: 15,
            quote: 'Do not publish.',
            role: 'user',
            seq: 1,
          },
        ],
      },
      new AbortController().signal,
    )
    expect(JSON.parse(String(result.payload))).toMatchObject({ atoms: [{ evidenceIds: [1] }] })
    expect(requests[0]).toMatchObject({
      model: 'model',
      max_tokens: 1500,
      response_format: { type: 'json_object' },
    })
    expect(result.report.unknownBilling).toBe(false)
  } finally {
    await ctx.fiber.dispose()
  }
})
