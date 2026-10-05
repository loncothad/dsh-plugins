import { readMediaResponse } from '@loncothad/dsh-media-gen'
import { SseDecoder } from '@loncothad/dsh-openai-wire'
import { getPiUserAgent, PI_ORIGINATOR } from '@loncothad/dsh-plugin-runtime'

/**
 * The four search providers this plugin mounts: Kagi (REST + recursive
 * envelope walker), OpenRouter (hosted web plugin + url_citation
 * annotations), Exa (REST highlights + keyless MCP fallback), and
 * OpenAI/Codex (Responses API web_search — via `OPENAI_API_KEY` or the
 * Codex subscription account when one is signed in). All classify failures
 * through the shared transport.
 *
 * @module @loncothad/dsh-web-search/providers
 */

import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import { WebError } from '@deepseek-ai/dsh-web'
import { getJson, postJson, readJson, type SearchHttpOptions, searchFailure } from './http.ts'
import {
  buildExaMcpBody,
  type ExaSearchResponse,
  exaErrorMessage,
  mapExaMcpResult,
  mapExaResponse,
} from './providers/exa.ts'
import { kagiErrorMessage, mapKagiResponse } from './providers/kagi.ts'
import { mapResponsesOutput, type ResponsesEnvelope } from './providers/openai.ts'
import {
  buildOpenRouterBody,
  mapOpenRouterResponse,
  type OpenRouterResponse,
} from './providers/openrouter.ts'

export { searchFailure } from './http.ts'
export * from './providers/exa.ts'
export * from './providers/kagi.ts'
export * from './providers/openai.ts'
export * from './providers/openrouter.ts'

const USER_AGENT = getPiUserAgent()

/** Stable id of the Kagi provider. */
export const KAGI_PROVIDER_ID = 'kagi'
/** Default Kagi search endpoint; `/search` is the operation. */
export const KAGI_DEFAULT_BASE_URL = 'https://kagi.com/api/v1'

/** Stable id of the OpenRouter provider. */
export const OPENROUTER_PROVIDER_ID = 'openrouter'
/** Default OpenRouter endpoint; `/chat/completions` is the operation. */
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
/** Default model carrying OpenRouter's hosted web plugin. */
export const OPENROUTER_DEFAULT_MODEL = 'openrouter/auto'

/** Stable id of the Exa provider. */
export const EXA_PROVIDER_ID = 'exa'
/** Default Exa REST endpoint; `/search` is the operation. */
export const EXA_DEFAULT_BASE_URL = 'https://api.exa.ai'
/** Keyless MCP fallback endpoint (JSON-RPC tools/call web_search_exa). */
export const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'

/** Stable id of the OpenAI/Codex provider. */
export const OPENAI_PROVIDER_ID = 'openai'
/** api.openai.com Responses endpoint (API-key path). */
export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
/** ChatGPT Codex Responses endpoint (subscription path). */
export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

/** Provider configuration resolved by the plugin binding. */
export interface ProviderOptions {
  readonly apiKey: string
  readonly baseURL: string
  /** HTTP transport override for tests. */
  readonly transport?: typeof fetch
}

/** Kagi-backed search provider. */
export class KagiSearchProvider implements WebSearchProvider {
  readonly id = KAGI_PROVIDER_ID

  private readonly http: SearchHttpOptions

  constructor(options: ProviderOptions & { limit?: number }) {
    this.http = {
      endpoint: `${options.baseURL.replace(/\/$/, '')}/search`,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'user-agent': USER_AGENT,
      },
      ...(options.transport !== undefined ? { fetch: options.transport } : {}),
    }
    this.limit = options.limit
  }

  /** Default result count when a request carries no `maxResults`. */
  private readonly limit?: number

  available(): boolean {
    const key = this.http.headers.authorization ?? ''
    return key.length > 'Bearer '.length && URL.canParse(this.http.endpoint)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const limit = request.maxResults ?? this.limit
    const url = new URL(this.http.endpoint)
    url.searchParams.set('q', request.query)
    if (limit !== undefined) url.searchParams.set('limit', String(limit))
    const response = await getJson(
      this.http.fetch ?? fetch,
      url.toString(),
      this.http.headers,
      signal,
      'Kagi search',
    )
    if (!response.ok) {
      const payload = await readJson(response, signal, 'Kagi search').catch(() => undefined)
      const detail = kagiErrorMessage(payload)
      throw new WebError(
        detail !== undefined ? detail : `Kagi API error (HTTP ${response.status})`,
        'WEB_PROVIDER_ERROR',
      )
    }
    const body = await readJson(response, signal, 'Kagi search')
    return { ...mapKagiResponse(body), truncated: false }
  }
}

/** OpenRouter-backed search provider (hosted web plugin). */
export class OpenRouterSearchProvider implements WebSearchProvider {
  readonly id = OPENROUTER_PROVIDER_ID

  private readonly http: SearchHttpOptions

  constructor(private readonly options: ProviderOptions & { model: string }) {
    this.http = {
      endpoint: `${options.baseURL.replace(/\/$/, '')}/chat/completions`,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'user-agent': USER_AGENT,
      },
      ...(options.transport !== undefined ? { fetch: options.transport } : {}),
    }
  }

  available(): boolean {
    return (
      this.options.apiKey.length > 0 &&
      URL.canParse(this.http.endpoint) &&
      this.options.model.length > 0
    )
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const body = buildOpenRouterBody(request.query, {
      model: this.options.model,
      ...(request.maxResults !== undefined ? { maxResults: request.maxResults } : {}),
    })
    const response = await postJson(
      this.http.fetch ?? fetch,
      this.http.endpoint,
      this.http.headers,
      body,
      signal,
      'OpenRouter search',
    )
    const payload = (await readJson(response, signal, 'OpenRouter search')) as OpenRouterResponse
    if (!response.ok) {
      const detail = payload.error?.message
      throw new WebError(
        detail !== undefined && detail.length > 0
          ? detail
          : `OpenRouter API error (HTTP ${response.status})`,
        'WEB_PROVIDER_ERROR',
      )
    }
    return { ...mapOpenRouterResponse(payload), truncated: false }
  }
}

/** Exa-backed search provider (REST highlights; keyless MCP fallback). */
export class ExaSearchProvider implements WebSearchProvider {
  readonly id = EXA_PROVIDER_ID

  private readonly http: SearchHttpOptions
  private readonly mcpUrl: string
  private readonly transport: typeof fetch

  constructor(options: ProviderOptions & { limit?: number; mcpUrl?: string }) {
    this.http = {
      endpoint: `${options.baseURL.replace(/\/$/, '')}/search`,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'user-agent': USER_AGENT,
      },
      ...(options.transport !== undefined ? { fetch: options.transport } : {}),
    }
    this.mcpUrl = options.mcpUrl ?? EXA_MCP_URL
    this.transport = options.transport ?? fetch
    this.limit = options.limit
  }

  /** Default result count when a request carries no `maxResults`. */
  private readonly limit?: number

  /** Always usable: with a key it uses REST, without it the keyless MCP fallback. */
  available(): boolean {
    return URL.canParse(this.http.endpoint) && URL.canParse(this.mcpUrl)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (this.optionsKeyPresent()) {
      return this.searchRest(request, signal)
    }
    return this.searchMcp(request, signal)
  }

  private optionsKeyPresent(): boolean {
    const key = this.http.headers.authorization ?? ''
    return key.length > 'Bearer '.length
  }

  private async searchRest(
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const numResults = request.maxResults ?? this.limit
    const body: Record<string, unknown> = {
      query: request.query,
      type: 'auto',
      contents: { highlights: { highlightsPerUrl: 1 } },
      ...(numResults !== undefined ? { numResults } : {}),
    }
    const response = await postJson(
      this.http.fetch ?? fetch,
      this.http.endpoint,
      this.http.headers,
      body,
      signal,
      'Exa search',
    )
    if (!response.ok) {
      const payload = await readJson(response, signal, 'Exa search').catch(() => undefined)
      const detail = exaErrorMessage(payload)
      throw new WebError(
        detail !== undefined ? detail : `Exa API error (HTTP ${response.status})`,
        'WEB_PROVIDER_ERROR',
      )
    }
    const envelope = (await readJson(response, signal, 'Exa search')) as ExaSearchResponse
    return { ...mapExaResponse(envelope), truncated: false }
  }

  private async searchMcp(
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const body = buildExaMcpBody(request.query, request.maxResults ?? this.limit)
    const response = await postJson(
      this.transport,
      this.mcpUrl,
      { 'user-agent': USER_AGENT, accept: 'application/json' },
      body,
      signal,
      'Exa MCP search',
    )
    const payload = await readJson(response, signal, 'Exa MCP search')
    return { ...mapExaMcpResult(payload as never), truncated: false }
  }
}

/**
 * OpenAI/Codex search provider over the Responses API `web_search` tool.
 * Two transports, preferred in order:
 * - Codex subscription: the ChatGPT Codex Responses endpoint with the
 *   signed-in account's OAuth token (resolved through the credentials
 *   seam per request, never cached).
 * - API key: api.openai.com with `OPENAI_API_KEY`.
 */
export class OpenAIResponsesSearchProvider implements WebSearchProvider {
  readonly id: string

  private readonly options: {
    /** API-key path key; falls back to `$OPENAI_API_KEY`. */
    readonly mode?: 'api' | 'codex'
    readonly accountAvailable?: () => boolean
    readonly model?: string
    readonly timeoutMs?: number
    readonly apiKey: () => string | undefined
    /** API-key path endpoint override (gateway deployments). */
    readonly apiKeyEndpoint?: string
    /** Codex subscription path: resolves the account's access token + account id, or undefined when none is signed in. */
    readonly codexCredentials: (
      signal?: AbortSignal,
    ) => Promise<{ accessToken: string; accountId?: string } | undefined>
    /** HTTP transport override for tests. */
    readonly transport?: typeof fetch
  }

  private readonly transport: typeof fetch

  constructor(options: {
    /** API-key path key; falls back to `$OPENAI_API_KEY`. */
    readonly mode?: 'api' | 'codex'
    readonly accountAvailable?: () => boolean
    readonly model?: string
    readonly timeoutMs?: number
    readonly apiKey: () => string | undefined
    /** API-key path endpoint override (gateway deployments). */
    readonly apiKeyEndpoint?: string
    /** Codex subscription path: resolves the account's access token + account id, or undefined when none is signed in. */
    readonly codexCredentials: (
      signal?: AbortSignal,
    ) => Promise<{ accessToken: string; accountId?: string } | undefined>
    /** HTTP transport override for tests. */
    readonly transport?: typeof fetch
  }) {
    this.options = options
    this.id = options.mode === 'codex' ? 'codex' : OPENAI_PROVIDER_ID
    this.transport = options.transport ?? fetch
  }

  available(): boolean {
    return this.options.mode === 'codex'
      ? Boolean(this.options.accountAvailable?.())
      : Boolean(this.options.apiKey()?.trim())
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    signal = AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 60000),
    ])
    if (this.options.mode === 'codex') {
      const codex = await this.options.codexCredentials(signal)
      if (!codex)
        throw new WebError('Sign in and select an account in Plugins > ChatGPT Codex.', 'AUTH')
      return this.searchViaCodex(request, codex, signal)
    }
    const key = this.options.apiKey()
    if (key === undefined || key.length === 0) {
      throw new WebError('The OpenAI API search provider needs an OpenAI API key', 'AUTH')
    }
    return this.searchViaApiKey(request, key, signal)
  }

  private async searchViaApiKey(
    request: WebSearchRequest,
    key: string,
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const body = this.responsesBody(request, this.options.model ?? 'gpt-4.1-mini')
    const response = await this.post(
      this.options.apiKeyEndpoint ?? OPENAI_RESPONSES_URL,
      {
        authorization: `Bearer ${key}`,
        'user-agent': USER_AGENT,
      },
      body,
      signal,
    )
    return this.finish(response, signal, 'OpenAI search')
  }

  private async searchViaCodex(
    request: WebSearchRequest,
    credentials: { accessToken: string; accountId?: string },
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const body = this.responsesBody(request, this.options.model ?? 'gpt-6-luna')
    const response = await this.post(
      CODEX_RESPONSES_URL,
      {
        authorization: `Bearer ${credentials.accessToken}`,
        'user-agent': USER_AGENT,
        originator: PI_ORIGINATOR,
        ...(credentials.accountId !== undefined
          ? { 'chatgpt-account-id': credentials.accountId }
          : {}),
      },
      { ...body, stream: true },
      signal,
    )
    // The Codex backend streams; aggregate the completed envelope.
    const envelope = await this.aggregateSse(response, signal)
    return this.finishEnvelope(envelope, undefined, 'Codex search')
  }

  private responsesBody(request: WebSearchRequest, model: string): Record<string, unknown> {
    return {
      model,
      instructions: 'Search the web for the user query and cite sources.',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: request.query }],
        },
      ],
      tools: [{ type: 'web_search' }],
      store: false,
    }
  }

  private async post(
    url: string,
    headers: Readonly<Record<string, string>>,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    try {
      return await (this.transport ?? fetch)(url, {
        method: 'POST',
        redirect: 'error',
        headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (error: unknown) {
      throw searchFailure('OpenAI search request failed', error, signal)
    }
  }

  /** Aggregate a streaming Responses reply into its completed envelope. */
  private async aggregateSse(response: Response, signal?: AbortSignal): Promise<ResponsesEnvelope> {
    if (!response.ok) {
      await response.body?.cancel()
      throw new WebError(`Codex search HTTP ${response.status}`, 'WEB_PROVIDER_ERROR')
    }
    const bytes = await readMediaResponse(
        response,
        8 * 1024 * 1024,
        signal ?? AbortSignal.timeout(this.options.timeoutMs ?? 60000),
      ),
      decoder = new SseDecoder(),
      frames = decoder
        .push(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        .concat(decoder.flush())
    let completed: ResponsesEnvelope | undefined
    for (const frame of frames) {
      if (frame === '[DONE]') continue
      const event = JSON.parse(frame) as { type?: string; response?: ResponsesEnvelope }
      if (['error', 'response.failed', 'response.incomplete'].includes(event.type ?? ''))
        throw new WebError('Codex search response failed or was incomplete', 'WEB_PROVIDER_ERROR')
      if (event.type === 'response.completed' && event.response) completed = event.response
    }
    if (!completed)
      throw new WebError('Codex search ended without a completed response', 'WEB_PROVIDER_ERROR')
    return completed
  }

  private async finish(
    response: Response,
    signal: AbortSignal | undefined,
    label: string,
  ): Promise<WebSearchResult> {
    const envelope = (await readJson(response, signal, label)) as ResponsesEnvelope
    return this.finishEnvelope(envelope, response, label)
  }

  private finishEnvelope(
    envelope: ResponsesEnvelope,
    response?: Response,
    label = 'OpenAI search',
  ): WebSearchResult {
    try {
      return { ...mapResponsesOutput(envelope), truncated: false }
    } catch (error: unknown) {
      const status = response !== undefined ? ` (HTTP ${response.status})` : ''
      throw new WebError(`${label} failed${status}: ${String(error)}`, 'WEB_PROVIDER_ERROR', {
        cause: error,
      })
    }
  }
}
