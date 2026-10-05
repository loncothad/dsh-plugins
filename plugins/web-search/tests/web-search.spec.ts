import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import {
  buildExaMcpBody,
  exaErrorMessage,
  mapExaMcpResult,
  mapExaResponse,
} from '../src/providers/exa.ts'
import { collectKagiSources, kagiErrorMessage, mapKagiResponse } from '../src/providers/kagi.ts'
import { mapResponsesOutput } from '../src/providers/openai.ts'
import { buildOpenRouterBody, mapCitations } from '../src/providers/openrouter.ts'
import {
  ExaSearchProvider,
  KagiSearchProvider,
  OpenAIResponsesSearchProvider,
  OpenRouterSearchProvider,
} from '../src/providers.ts'

const kagiEnvelope = {
  meta: { id: 'x' },
  data: [
    {
      t: 0,
      url: 'https://a.example/x',
      title: 'A result',
      snippet: 'first snippet',
      pub_date: '2026-01-02',
    },
    { t: 1, news: [{ url: 'https://b.example/y', title: 'B result', snippet: 'second' }] },
  ],
  error: null,
}

const openrouterEnvelope = {
  choices: [
    {
      message: {
        content: 'An answer with sources.',
        annotations: [
          {
            type: 'url_citation',
            url_citation: { url: 'https://a.example/1', title: 'A', content: 'snippet a' },
          },
          { type: 'url_citation', url_citation: { url: 'https://a.example/1', title: 'A dup' } },
          { type: 'url_citation', url_citation: { url: 'https://b.example/2' } },
          { type: 'other' },
        ],
      },
    },
  ],
}

const exaEnvelope = {
  results: [
    {
      url: 'https://a.example/x',
      title: 'A',
      highlights: ['first highlight'],
      publishedDate: '2026-01-02',
    },
    { url: 'https://b.example/y', title: 'B', highlights: [] },
  ],
}

const responsesEnvelope = {
  output: [
    { type: 'web_search_call', id: 'ws_1' },
    {
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: 'An answer.',
          annotations: [
            { type: 'url_citation', url: 'https://a.example/1', title: 'A' },
            { type: 'url_citation', url: 'https://b.example/2' },
            { type: 'other' },
          ],
        },
      ],
    },
  ],
}

describe('kagi provider', () => {
  it('collects sources from nested buckets recursively', () => {
    expect(collectKagiSources(kagiEnvelope)).toEqual([
      {
        url: 'https://a.example/x',
        title: 'A result',
        snippet: 'first snippet',
        publishedAt: '2026-01-02',
      },
      { url: 'https://b.example/y', title: 'B result', snippet: 'second' },
    ])
  })

  it('extracts error envelope messages', () => {
    expect(kagiErrorMessage({ error: { message: 'quota exceeded' } })).toBe('quota exceeded')
    expect(kagiErrorMessage(null)).toBeUndefined()
    expect(mapKagiResponse({}).sources).toEqual([])
  })

  it('sends the bearer key and limit, and maps the envelope', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(kagiEnvelope), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const provider = new KagiSearchProvider({
      apiKey: 'key-1',
      baseURL: 'https://kagi.test/api',
      transport: fetch,
    })
    const result = await provider.search({ query: 'hello world', maxResults: 2 })
    expect(result.sources.map((source) => source.url)).toEqual([
      'https://a.example/x',
      'https://b.example/y',
    ])
    const call = fetch.mock.calls[0] as unknown as [URL, RequestInit]
    expect(call[0].toString()).toBe('https://kagi.test/api/search?q=hello+world&limit=2')
  })
})

describe('openrouter provider', () => {
  it('builds the web-plugin request body', () => {
    expect(buildOpenRouterBody('hello', { model: 'openrouter/auto', maxResults: 7 })).toEqual({
      model: 'openrouter/auto',
      messages: [{ role: 'user', content: 'hello' }],
      plugins: [{ id: 'web', max_results: 7 }],
    })
  })

  it('maps citation annotations, deduplicating by url', () => {
    const message = openrouterEnvelope.choices[0]?.message
    expect(mapCitations(message)).toEqual([
      { url: 'https://a.example/1', title: 'A', snippet: 'snippet a' },
      { url: 'https://b.example/2' },
    ])
  })

  it('sends the bearer key with the web plugin and maps citations', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(openrouterEnvelope), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const provider = new OpenRouterSearchProvider({
      apiKey: 'key-1',
      baseURL: 'https://or.test/api',
      model: 'm1',
      transport: fetch,
    })
    const result = await provider.search({ query: 'q', maxResults: 5 })
    expect(result.content).toBe('An answer with sources.')
    const calls = fetch.mock.calls as unknown as [string, RequestInit][]
    expect(JSON.parse(calls[0]![1].body as string)).toMatchObject({
      model: 'm1',
      plugins: [{ id: 'web', max_results: 5 }],
    })
  })
})

describe('exa provider', () => {
  it('maps hits with highlights and drops the rest', () => {
    expect(mapExaResponse(exaEnvelope).sources).toEqual([
      {
        url: 'https://a.example/x',
        title: 'A',
        snippet: 'first highlight',
        publishedAt: '2026-01-02',
      },
    ])
    expect(exaErrorMessage({ error: 'bad key' })).toBe('bad key')
    expect(buildExaMcpBody('q', 5).params).toMatchObject({
      name: 'web_search_exa',
      arguments: { query: 'q', numResults: 5 },
    })
    expect(
      mapExaMcpResult({
        result: {
          content: [{ type: 'text', text: JSON.stringify([{ url: 'https://m.example/1' }]) }],
        },
      }).sources.map((source) => source.url),
    ).toEqual(['https://m.example/1'])
  })

  it('uses REST with the key and the keyless MCP fallback without', async () => {
    const fetchRest = vi.fn(
      async () =>
        new Response(JSON.stringify(exaEnvelope), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const rest = new ExaSearchProvider({
      apiKey: 'k',
      baseURL: 'https://exa.test',
      transport: fetchRest,
    })
    const restResult = await rest.search({ query: 'q', maxResults: 3 })
    expect(restResult.sources).toHaveLength(1)
    const restCall = fetchRest.mock.calls[0] as unknown as [string, RequestInit]
    expect(restCall[0]).toBe('https://exa.test/search')

    const mcpPayload = JSON.stringify([{ url: 'https://m.example/1' }])
    const fetchMcp = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            result: { content: [{ type: 'text', text: mcpPayload }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    const mcp = new ExaSearchProvider({
      apiKey: '',
      baseURL: 'https://exa.test',
      transport: fetchMcp,
    })
    expect(mcp.available()).toBe(true)
    const mcpResult = await mcp.search({ query: 'q' })
    expect(mcpResult.sources.map((source) => source.url)).toEqual(['https://m.example/1'])
    const mcpCall = fetchMcp.mock.calls[0] as unknown as [string, RequestInit]
    expect(mcpCall[0]).toBe('https://mcp.exa.ai/mcp')
  })
})

describe('openai/codex provider', () => {
  it('maps message text and url_citation annotations', () => {
    expect(mapResponsesOutput(responsesEnvelope)).toEqual({
      content: 'An answer.',
      sources: [{ url: 'https://a.example/1', title: 'A' }, { url: 'https://b.example/2' }],
    })
    expect(() => mapResponsesOutput({ error: { message: 'usage limit' } })).toThrow('usage limit')
  })

  it('uses the selected Codex subscription path and account headers', async () => {
    // The Codex backend streams; the completed envelope rides the final
    // response.completed SSE event.
    const sse =
      'data: ' +
      JSON.stringify({
        type: 'response.completed',
        response: responsesEnvelope,
      }) +
      '\n\n'
    const fetch = vi.fn(
      async () =>
        new Response(sse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    )
    const provider = new OpenAIResponsesSearchProvider({
      apiKey: () => undefined,
      mode: 'codex',
      codexCredentials: async () => ({ accessToken: 'sub-token', accountId: 'acct-9' }),
      transport: fetch as unknown as typeof fetch,
    })
    const result = await provider.search({ query: 'q' })
    expect(result.content).toBe('An answer.')
    expect(result.sources).toHaveLength(2)
    const calls = fetch.mock.calls as unknown as [string, RequestInit][]
    expect(calls[0]![0]).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(calls[0]![1].headers).toMatchObject({
      authorization: 'Bearer sub-token',
      'chatgpt-account-id': 'acct-9',
      originator: 'pi',
      'user-agent': expect.stringMatching(/^pi \(.*; .*\)$/),
    })
  })

  it('uses the separate OpenAI API path', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(responsesEnvelope), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const provider = new OpenAIResponsesSearchProvider({
      apiKey: () => 'oai-key',
      codexCredentials: async () => undefined,
      transport: fetch as unknown as typeof fetch,
    })
    const result = await provider.search({ query: 'q' })
    expect(result.content).toBe('An answer.')
    const calls = fetch.mock.calls as unknown as [string, RequestInit][]
    expect(calls[0]![0]).toBe('https://api.openai.com/v1/responses')
    expect(JSON.parse(calls[0]![1].body as string).tools).toEqual([{ type: 'web_search' }])
  })

  it('fails with AUTH when the selected provider has no credential', async () => {
    const fetch = vi.fn()
    const provider = new OpenAIResponsesSearchProvider({
      apiKey: () => undefined,
      codexCredentials: async () => undefined,
      transport: fetch as unknown as typeof fetch,
    })
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'AUTH' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('plugin binding', () => {
  it('registers separate API and subscription providers and disposes cleanly', async () => {
    const ctx = new Context()
    const registered: { id: string }[] = []
    const disposeWeb = ctx.provide('web', {
      registerSearchProvider(provider: { id: string }): () => void {
        registered.push(provider)
        return () => {}
      },
    })
    const disposeCreds = ctx.provide('credentials', {
      readRecord: async () => undefined,
      modifyRecord: async () => undefined,
    })
    const handle = await ctx.plugin(plugin, {
      kagiEnabled: true,
      openrouterEnabled: true,
      codexEnabled: true,
      openaiEnabled: true,
      kagiApiKey: 'k1',
      openrouterApiKey: 'k2',
      exaApiKey: 'k3',
      openaiApiKey: 'k4',
    })
    expect(registered.map((provider) => provider.id)).toEqual([
      'kagi',
      'openrouter',
      'exa',
      'openai',
      'codex',
    ])
    await handle.dispose()
    disposeWeb()
    disposeCreds()
  })
})

it('defaults to Exa only and does not activate keyed search without a key', async () => {
  const ctx = new Context(),
    registered: { id: string; available(): boolean }[] = []
  const saved = Object.fromEntries(
    ['KAGI_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'].map((key) => [key, process.env[key]]),
  )
  try {
    for (const key of Object.keys(saved)) delete process.env[key]
    ctx.provide('web', {
      registerSearchProvider: (provider: { id: string; available(): boolean }) => {
        registered.push(provider)
        return () => {}
      },
    })
    await ctx.plugin(plugin, {
      kagiEnabled: true,
      openrouterEnabled: true,
      openaiEnabled: true,
      codexEnabled: true,
    })
    expect(registered.map((p) => p.id)).toEqual(['exa', 'codex'])
    expect(registered.find((p) => p.id === 'codex')?.available()).toBe(false)
  } finally {
    await ctx.fiber.dispose()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
