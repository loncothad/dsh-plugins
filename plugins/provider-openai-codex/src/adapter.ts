import { getPiUserAgent } from '@loncothad/dsh-plugin-runtime'
/**
 * `CodexAdapter`: a `LlmAdapter` streaming from the ChatGPT Codex
 * Responses endpoint with the active account's OAuth tokens. Token
 * resolution re-reads the store per call (fresh credentials reach the next
 * operation without a restart), refreshing when due; a 401 mid-stream
 * forces one refresh and retry.
 *
 * @module @loncothad/dsh-provider-openai-codex/adapter
 */

import { createHash } from 'node:crypto'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { CatalogModel } from '@loncothad/dsh-llm-openai-compat'
import { toModelReasoning } from '@loncothad/dsh-llm-openai-compat'
import { readMediaResponse } from '@loncothad/dsh-media-gen'
import type {
  ResponsesStreamEvent,
  WireEvent,
  WireMessage,
  WireRequest,
} from '@loncothad/dsh-openai-wire'
import { buildResponsesBody, parseResponsesEvent, SseDecoder } from '@loncothad/dsh-openai-wire'
import {
  type CatalogCache,
  CODEX_MODELS_TIMEOUT_MS,
  CODEX_MODELS_URL,
  cacheFresh,
  modelsUrl,
  parseModelsResponse,
  serviceTierForRequest,
} from './discovery.ts'
import {
  accountPayloadFrom,
  CODEX_ORIGINATOR,
  CODEX_RESPONSES_ENDPOINT,
  type CodexAccountPayload,
  needsRefresh,
  OAUTH_TOKEN_ENDPOINT,
  refreshTokenRequestBody,
} from './oauth.ts'
import type { CodexAccountStore } from './store.ts'

const USER_AGENT = getPiUserAgent()

/** Resolved adapter options. */
export interface CodexAdapterOptions {
  /** The account store tokens resolve through. */
  readonly lifetime?: AbortSignal
  readonly timeoutMs?: number
  readonly store: CodexAccountStore
  /** Endpoint override. */
  readonly endpoint?: string
  readonly catalogProtocolVersion?: string
  /** Resolves the requested service tier per call (`priority`, `ultrafast`, `flex`, `default`). */
  readonly serviceTier?: () => string | undefined
  /**
   * Cyber access program sent on every request as
   * `access_programs: { cyber }` (e.g. `daybreak_blue`) — the
   * verification-gated programs the backend enforces per account.
   */
  readonly accessProgram?: string
  /** Display name for the provider route (subscription/program markers). */
  readonly providerName?: string
  /** Narrows this adapter's catalog (the daybreak route's daybreak-capable models). */
  readonly modelFilter?: (model: CatalogModel) => boolean
  /**
   * Account fallback on quota exhaustion: when enabled, a quota 429
   * switches to the first stored account that is neither active nor
   * excluded and retries once.
   */
  readonly accountFallback?: {
    enabled(): boolean
    exclude(): readonly string[]
  }
  /** HTTP transport override for tests. */
  readonly fetch?: typeof fetch
  /** Clock override for tests. */
  readonly now?: () => number
}

/** One authenticated Codex Responses call. */
interface Auth {
  readonly selectionId: string
  readonly payload: CodexAccountPayload
}

/** The Codex-backed Responses adapter. */
export class CodexAdapter extends LlmAdapter {
  constructor(private readonly options: CodexAdapterOptions) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: this.options.providerName ?? 'ChatGPT Codex (subscription)' }
  }
  /** Host-only credential capability shared with image generation; refresh and removal fencing stay here. */
  async accountTokens(name: string, signal: AbortSignal, forceRefresh = false) {
    const payload = await this.options.store.read(name)
    if (!payload) throw new Error('The Codex account is no longer stored')
    return (await this.auth(forceRefresh, signal, { payload, selectionId: 'quota-reader' }))!
      .payload
  }
  async activeTokens(
    signal?: AbortSignal,
  ): Promise<{ accessToken: string; accountId?: string } | undefined> {
    const deadline = AbortSignal.any([
      signal ?? new AbortController().signal,
      this.options.lifetime ?? new AbortController().signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 300000),
    ])
    const auth = await this.auth(false, deadline)
    deadline.throwIfAborted()
    return auth
      ? {
          accessToken: auth.payload.tokens.accessToken,
          ...(auth.payload.accountId ? { accountId: auth.payload.accountId } : {}),
        }
      : undefined
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const catalog = await this.catalog()
    return catalog.models.map((model) => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...(model.description !== undefined ? { description: model.description } : {}),
    }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const catalog = await this.catalog(signal)
    const entry = catalog.models.find((candidate) => candidate.id === model)
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...(entry?.contextWindow !== undefined
        ? { context: { contextWindow: entry.contextWindow } }
        : {}),
      ...(entry?.description !== undefined ? { description: entry.description } : {}),
      ...(entry?.reasoning !== undefined ? { reasoning: toModelReasoning(entry.reasoning) } : {}),
    }
  }

  /**
   * The effective catalog: the backend's live model list while an account
   * is signed in (TTL-cached, official 5s refresh deadline). Only a real
   * catalog from the same credential generation is retained after failure. A `modelFilter` narrows the
   * result (the daybreak route serves only daybreak-capable models).
   */
  async catalog(signal?: AbortSignal): Promise<{ models: readonly CatalogModel[] }> {
    const auth = await this.auth(false, signal)
    if (!auth) {
      this.cache = undefined
      return this.filteredCatalog([])
    }
    return this.filteredCatalog(await this.catalogFor(auth.payload, signal))
  }
  private filteredCatalog(models: readonly CatalogModel[]): { models: readonly CatalogModel[] } {
    const filter = this.options.modelFilter
    return { models: filter ? models.filter(filter) : models }
  }
  /** Catalog identity includes the credential generation without retaining another plaintext token. */
  private catalogKey(payload: CodexAccountPayload): string {
    return createHash('sha256')
      .update(JSON.stringify([payload.name, payload.accountId, payload.tokens.accessToken]))
      .digest('hex')
  }
  private async catalogFor(
    payload: CodexAccountPayload,
    signal?: AbortSignal,
  ): Promise<readonly CatalogModel[]> {
    signal?.throwIfAborted()
    const now = this.options.now?.() ?? Date.now(),
      key = this.catalogKey(payload)
    const cached = this.cache?.key === key ? this.cache : undefined
    if (cacheFresh(cached, now)) return cached!.models
    try {
      const fetched = await this.fetchCatalog(payload, cached, signal)
      signal?.throwIfAborted()
      // A late response from a switched or removed account cannot replace the active catalog.
      const current = await this.options.store.activeAccount()
      signal?.throwIfAborted()
      if (current && this.catalogKey(current) === key)
        this.cache = { ...fetched, fetchedAt: now, key }
      return fetched.models
    } catch {
      signal?.throwIfAborted()
      if (cached) return cached.models
      throw new Error(
        'The Codex model catalog could not be loaded. Check sign-in and the configured catalog protocol version.',
      )
    }
  }
  /** Resolve tiers against the same credential snapshot that performs this attempt. */
  private async effectiveServiceTier(
    model: string,
    payload: CodexAccountPayload,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const requested = this.options.serviceTier?.()
    if (requested === undefined) return undefined
    const models = await this.catalogFor(payload, signal)
    return serviceTierForRequest(
      models.find((candidate) => candidate.id === model),
      requested,
    )
  }

  /** One GET against the models endpoint with the account's headers. */
  private async fetchCatalog(
    payload: CodexAccountPayload,
    cached?: CatalogCache,
    signal?: AbortSignal,
  ): Promise<{ models: readonly CatalogModel[]; etag?: string }> {
    const endpoint = this.modelsEndpoint
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(CODEX_MODELS_TIMEOUT_MS)])
      : AbortSignal.timeout(CODEX_MODELS_TIMEOUT_MS)
    const response = await (this.options.fetch ?? fetch)(
      modelsUrl(endpoint, this.options.catalogProtocolVersion),
      {
        method: 'GET',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${payload.tokens.accessToken}`,
          accept: 'application/json',
          'user-agent': USER_AGENT,
          originator: CODEX_ORIGINATOR,
          ...(payload.accountId !== undefined ? { 'chatgpt-account-id': payload.accountId } : {}),
          ...(cached?.etag !== undefined ? { 'if-none-match': cached.etag } : {}),
        },
        signal: requestSignal,
      },
    )
    if (response.status === 304 && cached !== undefined) {
      return { models: cached.models, ...(cached.etag !== undefined ? { etag: cached.etag } : {}) }
    }
    if (!response.ok) {
      throw new Error(`the models request failed (HTTP ${response.status})`)
    }
    const catalogBody: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await readMediaResponse(response, 8 * 1024 * 1024, requestSignal),
      ),
    )
    const catalog = parseModelsResponse(catalogBody)
    const etag = response.headers.get('etag') ?? undefined
    return { models: catalog.models, ...(etag !== undefined ? { etag } : {}) }
  }

  /** The models endpoint derived from the configured Responses endpoint:
   * `.../codex/responses` -> `.../codex/models`; anything else falls back
   * to the canonical backend URL. */
  private get modelsEndpoint(): string {
    const endpoint = this.options.endpoint ?? CODEX_RESPONSES_ENDPOINT
    return endpoint.endsWith('/responses')
      ? `${endpoint.slice(0, -'/responses'.length)}/models`
      : CODEX_MODELS_URL
  }

  /** The last fetched catalog, when one succeeded. */
  private cache: (CatalogCache & { key: string }) | undefined

  /** The active account, refreshed through the store when due. */
  private async auth(
    forceRefresh = false,
    signal?: AbortSignal,
    pinned?: Auth,
  ): Promise<Auth | undefined> {
    signal?.throwIfAborted()
    const selected = pinned ? undefined : await this.options.store.selection()
    const payload = pinned ? await this.options.store.read(pinned.payload.name) : selected?.account
    const selectionId = pinned?.selectionId ?? selected!.id
    signal?.throwIfAborted()
    if (payload === undefined) return undefined
    const name = payload.name
    if (!forceRefresh && !needsRefresh(payload, this.options.now?.() ?? Date.now())) {
      return { payload, selectionId }
    }
    const refreshToken = payload.tokens.refreshToken
    if (refreshToken === undefined) return { payload, selectionId }
    // Rotation runs inside the credential store's serialized transaction. A second
    // adapter/process reuses the committed generation instead of spending a token twice.
    const committed = await this.options.store.write(
      name,
      async (previous) => {
        signal?.throwIfAborted()
        if (!previous) throw new Error('Codex account was removed during token refresh')
        const response = await this.exchange(refreshTokenRequestBody(refreshToken), signal)
        signal?.throwIfAborted()
        return accountPayloadFrom(name, response, previous, this.options.now?.() ?? Date.now())
      },
      payload.tokens.accessToken,
    )
    signal?.throwIfAborted()
    return { payload: committed, selectionId }
  }

  /** One form-encoded token-endpoint exchange. */
  private async exchange(body: ReturnType<typeof refreshTokenRequestBody>, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const response = await (this.options.fetch ?? fetch)(OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify(body),
    })
    const bytes = await readMediaResponse(
      response,
      64 * 1024,
      signal ?? AbortSignal.timeout(30_000),
    )
    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      throw new Error('Invalid Codex token response')
    }
    if (!response.ok) {
      const error =
        payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : typeof error === 'string'
            ? error
            : undefined
      const known = [
        'refresh_token_expired',
        'refresh_token_reused',
        'refresh_token_invalidated',
        'invalid_grant',
      ].includes(String(code))
        ? ` (${code})`
        : ''
      throw new Error(
        `Codex token refresh failed (HTTP ${response.status})${known}. Sign in again if the grant has expired or been revoked.`,
      )
    }
    const { parseTokenResponse } = await import('./oauth.ts')
    return parseTokenResponse(payload)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.maxTokens !== undefined) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'UNSUPPORTED_PARAMETER',
            message:
              'The native Codex subscription protocol does not support an output-token cap. Remove maxTokens explicitly or use a provider that supports it.',
          },
        },
      }
      return
    }
    options = {
      ...options,
      signal: AbortSignal.any([
        options.signal ?? new AbortController().signal,
        this.options.lifetime ?? new AbortController().signal,
        AbortSignal.timeout(this.options.timeoutMs ?? 300000),
      ]),
    }
    options.signal!.throwIfAborted()
    const auth = await this.auth(false, options.signal)
    if (auth === undefined) {
      yield authMissing()
      return
    }
    let currentAuth = auth
    let outcome = yield* this.attempt(options, currentAuth.payload)
    if (outcome === 'unauthorized') {
      const refreshed = await this.auth(true, options.signal, currentAuth)
      if (refreshed !== undefined) {
        currentAuth = refreshed
        outcome = yield* this.attempt(options, refreshed.payload)
      }
    }
    if (outcome === 'quota') {
      options.signal?.throwIfAborted()
      // Quota exhaustion is account-wide on this subscription; the next
      // stored account is a different quota. Switch and retry once.
      const next = await this.nextAccount(currentAuth.payload.name)
      if (next !== undefined) {
        options.signal?.throwIfAborted()
        const selected = await this.options.store.switchActive(currentAuth.selectionId, next)
        const switched = selected?.account
          ? await this.auth(false, options.signal, {
              selectionId: selected.id,
              payload: selected.account,
            })
          : undefined
        if (switched !== undefined) {
          outcome = yield* this.attempt(options, switched.payload)
        }
      }
      if (outcome === 'quota') {
        yield quotaFinish()
      }
    }
    if (outcome === 'unauthorized') yield httpFinish(401)
  }

  /**
   * The next fallback account: the first stored account that is neither
   * active nor excluded, when account fallback is enabled. Undefined
   * when disabled, excluded, or no other account exists.
   */
  private async nextAccount(exhausted: string): Promise<string | undefined> {
    const fallback = this.options.accountFallback
    if (fallback === undefined || !fallback.enabled()) return undefined
    const active = await this.options.store.active()
    if (active !== exhausted) return undefined
    const excluded = fallback.exclude()
    const names = await this.options.store.list()
    return names.find((name) => name !== active && !excluded.includes(name))
  }

  /** One authenticated attempt; reports 401 and quota outcomes for the caller's recovery. */
  private async *attempt(
    options: GenerateOptions,
    payload: CodexAccountPayload,
  ): AsyncGenerator<StreamChunk, 'done' | 'unauthorized' | 'quota'> {
    const serviceTier = await this.effectiveServiceTier(options.model, payload, options.signal)
    options.signal?.throwIfAborted()
    const request = toWireRequest(options, serviceTier, this.options.accessProgram)
    const body: Record<string, unknown> = { ...buildResponsesBody(request), store: false }
    const headers: Record<string, string> = {
      authorization: `Bearer ${payload.tokens.accessToken}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': USER_AGENT,
      originator: CODEX_ORIGINATOR,
      ...(payload.accountId !== undefined ? { 'chatgpt-account-id': payload.accountId } : {}),
    }
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(
        this.options.endpoint ?? CODEX_RESPONSES_ENDPOINT,
        {
          method: 'POST',
          redirect: 'error',
          headers,
          body: JSON.stringify(body),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        },
      )
    } catch (error: unknown) {
      yield transportFinish(options, error)
      return 'done'
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {})
      return 'unauthorized'
    }
    if (response.status === 429) {
      // The official client splits 429s: quota conditions (usage_limit_
      // reached, usage_not_included, insufficient_quota, credit_balance_
      // exhausted, spend-limit codes) are account-exhaustion; anything
      // else is a transient rate limit worth a plain retry.
      const bytes = await readMediaResponse(response, 64 * 1024, options.signal!)
      const text = new TextDecoder().decode(bytes)
      if (quotaExhausted(text)) return 'quota'
      yield httpFinish(response.status)
      return 'done'
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => {})
      yield httpFinish(response.status)
      return 'done'
    }
    const decoder = new SseDecoder()
    const reader = response.body.getReader()
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const data of decoder.push(value)) {
          if (data === '[DONE]') return 'done'
          let parsed: ResponsesStreamEvent
          try {
            parsed = JSON.parse(data) as ResponsesStreamEvent
          } catch {
            continue
          }
          for (const event of parseResponsesEvent(parsed)) {
            const done = yield* translate(event, toolCalls)
            if (done) return 'done'
          }
        }
      }
      for (const data of decoder.flush()) {
        if (data === '[DONE]') return 'done'
        try {
          for (const event of parseResponsesEvent(JSON.parse(data) as ResponsesStreamEvent)) {
            const done = yield* translate(event, toolCalls)
            if (done) return 'done'
          }
        } catch {
          // A trailing unparsable payload cannot contribute more content.
        }
      }
    } catch (error: unknown) {
      yield transportFinish(options, error)
      return 'done'
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return 'done'
  }
}

/** Translate wire events, closing tool blocks at finish; true when done. */
function* translate(
  event: WireEvent,
  toolCalls: Map<number, { id: string; name: string; arguments: string }>,
): Generator<StreamChunk, boolean> {
  switch (event.type) {
    case 'text-delta':
      yield { type: 'text-delta', index: 0, text: event.text }
      return false
    case 'reasoning-delta':
      yield { type: 'reasoning-delta', index: 1, text: event.text }
      return false
    case 'tool-call-start':
      toolCalls.set(event.index, { id: event.id, name: event.name, arguments: '' })
      yield {
        type: 'tool-call-delta',
        index: event.index,
        id: event.id as never,
        name: event.name,
        argumentsDelta: '',
      }
      return false
    case 'tool-call-delta': {
      const open = toolCalls.get(event.index)
      if (open !== undefined) open.arguments += event.delta
      yield {
        type: 'tool-call-delta',
        index: event.index,
        id: (open?.id ?? '') as never,
        argumentsDelta: event.delta,
      }
      return false
    }
    case 'usage':
      yield { type: 'usage', usage: event.usage }
      return false
    case 'finish': {
      for (const [index, call] of toolCalls) {
        yield {
          type: 'block-end',
          index,
          block: {
            type: 'tool-call',
            id: call.id as never,
            name: call.name,
            arguments: call.arguments,
          },
        }
      }
      yield { type: 'finish', reason: { kind: event.reason } }
      return true
    }
  }
}

/** Project one harness request onto the neutral wire request. */
function toWireRequest(
  options: GenerateOptions,
  serviceTier?: string,
  accessProgram?: string,
): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', text: options.system })
  }
  for (const message of options.messages) {
    const mapped = mapMessage(message)
    if (mapped !== undefined) messages.push(mapped)
  }
  return {
    model: options.model,
    messages,
    ...(options.tools !== undefined && options.tools.length > 0
      ? {
          tools: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        }
      : {}),
    ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    ...(accessProgram !== undefined
      ? { extraBody: { access_programs: { cyber: accessProgram } } }
      : {}),
  }
}

function mapMessage(message: RequestMessage): WireMessage | undefined {
  if (message.role === 'system') return { role: 'system', text: textOf(message.content) }
  if (message.role === 'user') return { role: 'user', text: textOf(message.content) }
  if (message.role === 'assistant') {
    const toolCalls = message.content
      .filter(
        (block): block is Extract<ContentBlock, { type: 'tool-call' }> =>
          block.type === 'tool-call',
      )
      .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments }))
    const text = textOf(message.content)
    return {
      role: 'assistant',
      ...(text.length > 0 ? { text } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    }
  }
  if (message.role === 'tool') {
    return { role: 'tool', toolCallId: message.source.callId, text: textOf(message.content) }
  }
  return undefined
}

function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text' || block.type === 'reasoning')
    .map((block) => block.text)
    .join('')
}

function authMissing(): StreamChunk {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message:
          'no active Codex account; sign in from Plugins → ChatGPT Codex → Subscription login',
        code: 'AUTH',
      },
    },
  }
}

/** A quota 429 with no fallback account available. */
function quotaFinish(): StreamChunk {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message:
          'the Codex account\u2019s quota is exhausted (usage limit reached); add another account from Plugins → ChatGPT Codex or wait for the limit to reset',
        code: 'RATE_LIMIT',
        status: 429,
      },
    },
  }
}

/**
 * Whether one 429 body reports quota exhaustion rather than a transient
 * rate limit, mirroring the official client's classification:
 * `error.error_type`/`error.code` of usage_limit_reached,
 * usage_not_included, insufficient_quota, credit_balance_exhausted, or
 * the spend/usage-limit-exceeded codes.
 */
export function quotaExhausted(body: string): boolean {
  const QUOTA_TYPES = new Set([
    'usage_limit_reached',
    'usage_not_included',
    'insufficient_quota',
    'credit_balance_exhausted',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded',
  ])
  try {
    const error = (JSON.parse(body) as { error?: { error_type?: unknown; code?: unknown } }).error
    if (typeof error !== 'object' || error === null) return false
    return (
      (typeof error.error_type === 'string' && QUOTA_TYPES.has(error.error_type)) ||
      (typeof error.code === 'string' && QUOTA_TYPES.has(error.code))
    )
  } catch {
    return false
  }
}

function transportFinish(options: GenerateOptions, _error: unknown): StreamChunk {
  if (options.signal?.aborted === true) {
    return {
      type: 'finish',
      reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } },
    }
  }
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: 'Codex transport or stream validation failed', code: 'TRANSPORT' },
    },
  }
}

function httpFinish(status: number): StreamChunk {
  const code =
    status === 401 || status === 403
      ? 'AUTH'
      : status === 429
        ? 'RATE_LIMIT'
        : status >= 500
          ? 'SERVER'
          : 'CLIENT'
  return {
    type: 'finish',
    reason: { kind: 'error', failure: { message: `provider HTTP ${status}`, code, status } },
  }
}
