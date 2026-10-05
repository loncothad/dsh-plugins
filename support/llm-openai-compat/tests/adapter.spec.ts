import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { OpenAICompatAdapter } from '../src/index.ts'

/** SSE body stream built from data payloads. */
function sseResponse(payloads: readonly string[], status = 200): Response {
  const body = `${payloads.map((payload) => `data: ${payload}\n\n`).join('')}data: [DONE]\n\n`
  const bytes = new TextEncoder().encode(body)
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
    { status, headers: { 'content-type': 'text/event-stream' } },
  )
}

const textStream = [
  JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] }),
  JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }),
  JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    id: 'r1',
    model: 'glm-5.3',
  }),
]

const toolStream = [
  JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 2, id: 'c1', function: { name: 'run', arguments: '{"a"' } }],
        },
      },
    ],
  }),
  JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 2, function: { arguments: ':1}' } }] } }],
  }),
  JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  }),
]

function adapter(fetchImpl: typeof fetch) {
  return new OpenAICompatAdapter({
    provider: 'mock',
    endpoint: 'https://mock.test/v1/chat/completions',
    apiKey: () => 'key-1',
    models: [{ id: 'glm-5.3', contextWindow: 1_000_000 }],
    fetch: fetchImpl,
  })
}

async function harness(fetchImpl: typeof fetch) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter(fetchImpl))
  return ctx
}

async function drive(ctx: Context): Promise<string> {
  const agent = await ctx.agentLoop.create(SessionId(`compat-${Math.random()}`), {
    provider: 'mock',
    model: 'glm-5.3',
  })
  agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }),
  )
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  const last = [...events].reverse().find((event) => event.type === 'assistant/message')
  return last !== undefined
    ? (
        last as { data: { message: { content: readonly { type: string; text?: string }[] } } }
      ).data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
    : ''
}

describe('openai-compat adapter in composition', () => {
  it('streams reasoning, text, and usage through the loop', async () => {
    let sentBody: Record<string, unknown> | undefined
    let sentHeaders: HeadersInit | undefined
    const ctx = await harness(async (_url, init) => {
      sentBody = JSON.parse(init?.body as string)
      sentHeaders = init?.headers
      return sseResponse(textStream)
    })
    const text = await drive(ctx)
    expect(text).toBe('hello')
    expect(sentBody).toMatchObject({ model: 'glm-5.3', stream: true })
    expect(sentHeaders).toMatchObject({ authorization: 'Bearer key-1' })
    await ctx.fiber.dispose()
  })

  it('surfaces HTTP failures as coded error finishes', async () => {
    const ctx = await harness(async () => new Response('no', { status: 429 }))
    const agent = await ctx.agentLoop.create(SessionId(`rate-${Math.random()}`), {
      provider: 'mock',
      model: 'glm-5.3',
    })
    agent.followup(
      createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
    )
    await agent.whenIdle()
    const attempts = agent.session
      .snapshotEvents()
      .filter((event) => event.type === 'assistant/attempt')
    expect(attempts.length).toBeGreaterThan(0)
    await ctx.fiber.dispose()
  })
})

describe('adapter stream translation', () => {
  it('assembles tool-call blocks, usage, and finish reasons directly', async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter(async () => sseResponse(toolStream)).stream({
      provider: 'mock',
      model: 'glm-5.3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    })) {
      chunks.push(chunk)
    }
    expect(chunks).toEqual([
      { type: 'block-start', index: 4, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 4, id: 'c1', name: 'run', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 4, id: 'c1', argumentsDelta: '{"a"' },
      { type: 'tool-call-delta', index: 4, id: 'c1', argumentsDelta: ':1}' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
      {
        type: 'block-end',
        index: 4,
        block: { type: 'tool-call', id: 'c1', name: 'run', arguments: '{"a":1}' },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('reports model metadata, display names, and reasoning from the catalog', async () => {
    const info = await adapter(async () => new Response('{}')).resolveModel('mock', 'glm-5.3')
    expect(info.context).toEqual({ contextWindow: 1_000_000 })
    const models = await adapter(async () => new Response('{}')).listModels('mock')
    expect(models.map((model) => model.id)).toEqual(['glm-5.3'])

    const rich = new OpenAICompatAdapter({
      provider: 'mock',
      endpoint: 'https://mock.test/v1/chat/completions',
      apiKey: () => 'key-1',
      models: [
        {
          id: 'glm-5.3',
          contextWindow: 1_000_000,
          name: 'GLM-5.3',
          description: 'fast flagship',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High', description: 'deep thinking' },
            ],
            defaultEffort: 'high',
          },
          serviceTiers: ['priority'],
        },
      ],
      fetch: async () => new Response('{}'),
    })
    const listed = await rich.listModels('mock')
    expect(listed[0]).toMatchObject({
      id: 'glm-5.3',
      name: 'GLM-5.3',
      description: 'fast flagship',
    })
    const resolved = await rich.resolveModel('mock', 'glm-5.3')
    expect(resolved.reasoning).toMatchObject({
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'high', name: 'High', description: 'deep thinking' },
      ],
      defaultEffort: 'high',
    })
    // Unknown ids keep bare metadata without invented capabilities.
    const unknown = await rich.resolveModel('mock', 'other')
    expect(unknown.name).toBe('other')
    expect(unknown.reasoning).toBeUndefined()
  })

  it('sends the configured service tier on every request', async () => {
    let sentBody: Record<string, unknown> | undefined
    const tiered = new OpenAICompatAdapter({
      provider: 'mock',
      endpoint: 'https://mock.test/v1/chat/completions',
      apiKey: () => 'key-1',
      models: [{ id: 'glm-5.3', contextWindow: 1_000 }],
      serviceTier: () => 'priority',
      fetch: async (_url, init) => {
        sentBody = JSON.parse(init?.body as string)
        return sseResponse(textStream)
      },
    })
    for await (const chunk of tiered.stream({
      provider: 'mock',
      model: 'glm-5.3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    })) {
      if (chunk.type === 'finish') break
    }
    expect(sentBody).toMatchObject({ service_tier: 'priority' })
  })

  it('fails fast with an AUTH finish when the key is missing', async () => {
    let called = false
    const missing = new OpenAICompatAdapter({
      provider: 'mock',
      endpoint: 'https://mock.test',
      apiKey: () => undefined,
      models: [],
      fetch: async () => {
        called = true
        return new Response('{}')
      },
    })
    const chunks: string[] = []
    for await (const chunk of missing.stream({
      provider: 'mock',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    })) {
      if (chunk.type === 'finish')
        chunks.push(chunk.reason.kind === 'error' ? chunk.reason.failure.code : chunk.reason.kind)
    }
    expect(chunks).toEqual(['AUTH'])
    expect(called).toBe(false)
  })
})

it('reports an incomplete provider stream instead of inventing successful completion', async () => {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter(async () =>
    sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] }),
    ]),
  ).stream({ provider: 'mock', model: 'glm-5.3', messages: [] }))
    chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({
    type: 'finish',
    reason: { kind: 'error', failure: { code: 'INCOMPLETE_PROVIDER_STREAM' } },
  })
})

it('accepts OpenRouter trailing usage with a repeated finish and closes blocks only once', async () => {
  const stream = [
    ...textStream,
    JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
    }),
  ]
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter(async () => sseResponse(stream)).stream({
    provider: 'mock',
    model: 'glm-5.3',
    messages: [],
    tools: [],
  }))
    chunks.push(chunk)
  expect(chunks.filter((chunk) => chunk.type === 'block-end')).toHaveLength(2)
  expect(chunks.filter((chunk) => chunk.type === 'finish')).toEqual([
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  expect(chunks.filter((chunk) => chunk.type === 'usage').at(-1)).toMatchObject({
    usage: { inputTokens: 11, outputTokens: 4 },
  })
})
it('redacts reflected transport failures and stops admission after provider disposal', async () => {
  const failed = adapter(async () => {
    throw new Error('Authorization: Bearer key-1')
  })
  const chunks: StreamChunk[] = []
  for await (const chunk of failed.stream({ provider: 'mock', model: 'glm-5.3', messages: [] }))
    chunks.push(chunk)
  expect(JSON.stringify(chunks)).not.toContain('key-1')
  const lifetime = new AbortController()
  lifetime.abort()
  let requests = 0
  const disposed = new OpenAICompatAdapter({
    provider: 'mock',
    endpoint: 'https://example.test',
    apiKey: () => 'key',
    models: [],
    lifetime: lifetime.signal,
    fetch: async () => {
      requests++
      return new Response()
    },
  })
  await expect(
    (async () => {
      for await (const _chunk of disposed.stream({ provider: 'mock', model: 'm', messages: [] })) {
      }
    })(),
  ).rejects.toThrow()
  expect(requests).toBe(0)
})
