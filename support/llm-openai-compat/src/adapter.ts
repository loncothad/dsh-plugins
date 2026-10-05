import { getPiUserAgent } from '@loncothad/dsh-plugin-runtime'

/**
 * `OpenAICompatAdapter`: a reusable `LlmAdapter` over the OpenAI chat
 * completions wire. Provider plugins (Z.AI, Daybreak, gateways) subclass
 * or configure it instead of re-implementing request projection, SSE
 * parsing, and chunk translation.
 *
 * @module @loncothad/dsh-llm-openai-compat/adapter
 */

import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ContentBlock,
  GenerateOptions,
  LlmImageRequestPricing,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  RequestMessage,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  fileHandleText,
  LlmAdapter,
  offloadedImageText,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  WireEvent,
  WireMessage,
  WireRequest,
  WireToolSchema,
} from '@loncothad/dsh-openai-wire'
import { buildCompletionsBody, parseCompletionsChunk, SseDecoder } from '@loncothad/dsh-openai-wire'

/** One selectable reasoning effort, as a catalog declares it. */
export interface CatalogReasoningEffort {
  /** Wire value (what the endpoint accepts). */
  readonly id: string
  /** Human-readable effort name for selectors. */
  readonly name: string
  /** Optional user-facing distinction. */
  readonly description?: string
}

/** Reasoning capabilities one catalog model advertises. */
export interface CatalogReasoning {
  /** Supported efforts in catalog-preferred display order. */
  readonly efforts: readonly CatalogReasoningEffort[]
  /** Effort materialized into requests when a caller omits one. */
  readonly defaultEffort?: string
}

/** One catalog model with its context window. */
export interface CatalogModel {
  readonly id: string
  readonly inputModalities?: LlmResolvedModelInfo['inputModalities']
  readonly contextWindow?: number
  /** Human-readable model name for selectors; defaults to the id. */
  readonly name?: string
  readonly description?: string
  /** Selectable reasoning efforts when the catalog discloses them. */
  readonly reasoning?: CatalogReasoning
  /** Backend-advertised service-tier ids (e.g. `priority`, `ultrafast`). */
  readonly serviceTiers?: readonly string[]
  /** Cyber access programs the backend advertises for this model (e.g. `daybreak_blue`). */
  readonly cyberPrograms?: readonly string[]
  /** Picker ordering hint; higher sorts first when the catalog supplies it. */
  readonly priority?: number
}

/** Project catalog reasoning capabilities onto the harness type. */
export function toModelReasoning(reasoning: CatalogReasoning): LlmModelReasoningInfo {
  return {
    efforts: reasoning.efforts.map((effort) => ({
      id: ReasoningEffortId(effort.id),
      name: effort.name,
      ...(effort.description !== undefined ? { description: effort.description } : {}),
    })),
    ...(reasoning.defaultEffort !== undefined
      ? { defaultEffort: ReasoningEffortId(reasoning.defaultEffort) }
      : {}),
  }
}

/** Configuration one provider route supplies. */
export interface OpenAICompatAdapterOptions {
  readonly lifetime?: AbortSignal
  readonly timeoutMs?: number
  readonly resolveAttachments?: () => AttachmentStore | undefined
  readonly imagePricing?: (model: string) => LlmImageRequestPricing | undefined
  /** Provider route key(s) this adapter is registered under. */
  readonly provider: string
  /** Chat-completions endpoint (full URL). */
  readonly endpoint: string
  /** Resolves the bearer key per call (may be async for credential stores); empty/undefined fails as AUTH. */
  readonly apiKey: () => string | undefined | Promise<string | undefined>
  /** Catalog models advertised by `listModels`. */
  readonly models: readonly CatalogModel[]
  /** Extra headers merged after auth and content type. */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * Display name for the provider route (subscription markers, live pins);
   * a getter re-resolves for each listing.
   */
  readonly providerName?: string | (() => string | undefined)
  /**
   * Extra body fields merged last on every request (router preferences
   * like OpenRouter's `provider` routing). A getter re-resolves per call,
   * so volatile settings apply to the next request.
   */
  readonly extraBody?: (options: GenerateOptions) => Record<string, unknown> | undefined
  /**
   * Service tier sent on every request when set (`priority` selects fast
   * handling on routes that support it). A getter re-resolves per call, so
   * volatile settings apply to the next request without re-registration.
   */
  readonly serviceTier?: string | (() => string | undefined)
  /** HTTP transport override for tests. */
  readonly fetch?: typeof fetch
}

const USER_AGENT = getPiUserAgent()

/**
 * The reusable chat-completions adapter. Mapping is the whole job: harness
 * messages onto the wire, wire chunks back onto harness stream chunks.
 */
export class OpenAICompatAdapter extends LlmAdapter {
  override imageRequestPricing(
    _provider: string,
    model: string,
  ): LlmImageRequestPricing | undefined {
    return this.options.imagePricing?.(model)
  }
  constructor(protected readonly options: OpenAICompatAdapterOptions) {
    super()
  }

  override providerInfo(provider: string) {
    const name = this.options.providerName
    return {
      id: provider,
      name: typeof name === 'function' ? (name() ?? provider) : (name ?? provider),
    }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.options.models.map((model) => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...(model.description !== undefined ? { description: model.description } : {}),
    }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const entry = this.options.models.find((candidate) => candidate.id === model)
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...(entry?.inputModalities ? { inputModalities: entry.inputModalities } : {}),
      ...(entry?.contextWindow !== undefined
        ? { context: { contextWindow: entry.contextWindow } }
        : {}),
      ...(entry?.description !== undefined ? { description: entry.description } : {}),
      ...(entry?.reasoning !== undefined ? { reasoning: toModelReasoning(entry.reasoning) } : {}),
    }
  }

  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options = {
      ...options,
      signal: AbortSignal.any([
        options.signal ?? new AbortController().signal,
        this.options.lifetime ?? new AbortController().signal,
        AbortSignal.timeout(this.options.timeoutMs ?? 300000),
      ]),
    }
    options.signal!.throwIfAborted()
    const request = await toWireRequest(options, this.options)
    const key = await this.options.apiKey()
    if (key === undefined || key.length === 0) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: `${this.options.provider}: the API key is not set`, code: 'AUTH' },
        },
      }
      return
    }
    options.signal!.throwIfAborted()
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(this.options.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'user-agent': USER_AGENT,
          ...this.options.headers,
        },
        body: JSON.stringify(buildCompletionsBody(request)),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      })
    } catch (error: unknown) {
      yield transportFinish(options, error)
      return
    }
    if (!response.ok || response.body === null) {
      yield httpFinish(response.status)
      return
    }
    const decoder = new SseDecoder()
    const reader = response.body.getReader()
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
    const state: StreamState = { text: '', reasoning: '', started: new Set() }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const payloads = decoder.push(value)
        for (const payload of payloads) {
          if (payload === '[DONE]') {
            yield terminalChunk(state)
            return
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(payload)
          } catch {
            continue
          }
          for (const event of parseCompletionsChunk(parsed as never)) {
            yield* toStreamChunks(event, toolCalls, state)
          }
        }
      }
      for (const payload of decoder.flush()) {
        if (payload === '[DONE]') {
          yield terminalChunk(state)
          return
        }
        try {
          for (const event of parseCompletionsChunk(JSON.parse(payload) as never)) {
            yield* toStreamChunks(event, toolCalls, state)
          }
        } catch {
          // A trailing unparsable payload cannot contribute more content.
        }
      }
    } catch (error: unknown) {
      yield transportFinish(options, error)
      return
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    // A stream that ended without a finish chunk still owes the loop one.
    yield terminalChunk(state)
  }
}

/** Resolve the configured service tier per call. */
function serviceTierOf(config: OpenAICompatAdapterOptions): string | undefined {
  if (config.serviceTier === undefined) return undefined
  return typeof config.serviceTier === 'function' ? config.serviceTier() : config.serviceTier
}

/** Project one harness request onto the neutral wire request. */
async function toWireRequest(
  options: GenerateOptions,
  config: OpenAICompatAdapterOptions,
): Promise<WireRequest> {
  const messages: WireMessage[] = []
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', text: options.system })
  }
  for (const message of options.messages) {
    const images: { data: string; mediaType: string }[] = []
    const content: ContentBlock[] = []
    for (const block of message.content) {
      if (block.type === 'file') {
        content.push({ type: 'text', text: fileHandleText(block.attachment, undefined) })
        continue
      }
      if (block.type !== 'image') {
        content.push(block)
        continue
      }
      if (block.offloaded) {
        content.push({ type: 'text', text: offloadedImageText(block.attachment, undefined) })
        continue
      }
      const attachments = config.resolveAttachments?.()
      if (!attachments)
        throw new Error('This provider requires the native attachment service to send images')
      const stored = await attachments.readImage(block.attachment, options.signal)
      images.push({
        data: Buffer.from(stored.data).toString('base64'),
        mediaType: block.attachment.mediaType,
      })
    }
    const mapped = mapMessage({ ...message, content })
    if (images.length && mapped) messages.push({ ...mapped, images })
    else if (mapped !== undefined) messages.push(mapped)
  }
  const tools: WireToolSchema[] | undefined = options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  const serviceTier = serviceTierOf(config)
  const extraBody = config.extraBody?.(options)
  return {
    model: options.model,
    messages,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
    ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    ...(extraBody !== undefined ? { extraBody } : {}),
  }
}

/** Map one harness message onto the wire; system prompts ride as system. */
function mapMessage(message: RequestMessage): WireMessage | undefined {
  if (message.role === 'system') {
    return { role: 'system', text: textOf(message.content) }
  }
  if (message.role === 'user') {
    return { role: 'user', text: textOf(message.content) }
  }
  if (message.role === 'assistant') {
    const toolCalls = message.content
      .filter(
        (block): block is Extract<ContentBlock, { type: 'tool-call' }> =>
          block.type === 'tool-call',
      )
      .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments }))
    return {
      role: 'assistant',
      ...(textOf(message.content).length > 0 ? { text: textOf(message.content) } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    }
  }
  if (message.role === 'tool') {
    return { role: 'tool', toolCallId: message.source.callId, text: textOf(message.content) }
  }
  return undefined
}

/** Concatenate text and reasoning blocks; tool blocks ride separately. */
function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text' || block.type === 'reasoning')
    .map((block) => block.text)
    .join('')
}

interface StreamState {
  text: string
  reasoning: string
  started: Set<number>
  finish?: 'stop' | 'tool-calls' | 'max-tokens'
}
function terminalChunk(state: StreamState): StreamChunk {
  return state.finish
    ? { type: 'finish', reason: { kind: state.finish } }
    : {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'INCOMPLETE_PROVIDER_STREAM',
            message: 'The provider closed its stream without a completion record',
          },
        },
      }
}

/** Translate wire events onto harness stream chunks. */
function* toStreamChunks(
  event: WireEvent,
  toolCalls: Map<number, { id: string; name: string; arguments: string }>,
  state: StreamState,
): Generator<StreamChunk> {
  if (state.finish && event.type !== 'usage' && event.type !== 'finish')
    throw new Error('Provider emitted content after completion')
  switch (event.type) {
    case 'text-delta':
      if (!state.started.has(0)) {
        state.started.add(0)
        yield { type: 'block-start', index: 0, blockType: 'text' }
      }
      state.text += event.text
      yield { type: 'text-delta', index: 0, text: event.text }
      break
    case 'reasoning-delta':
      if (!state.started.has(1)) {
        state.started.add(1)
        yield { type: 'block-start', index: 1, blockType: 'reasoning' }
      }
      state.reasoning += event.text
      yield { type: 'reasoning-delta', index: 1, text: event.text }
      break
    case 'tool-call-start': {
      yield { type: 'block-start', index: event.index + 2, blockType: 'tool-call' }
      toolCalls.set(event.index, { id: event.id, name: event.name, arguments: '' })
      yield {
        type: 'tool-call-delta',
        index: event.index + 2,
        id: event.id as never,
        name: event.name,
        argumentsDelta: '',
      }
      break
    }
    case 'tool-call-delta': {
      const open = toolCalls.get(event.index)
      if (open !== undefined) open.arguments += event.delta
      yield {
        type: 'tool-call-delta',
        index: event.index + 2,
        id: (open?.id ?? '') as never,
        argumentsDelta: event.delta,
      }
      break
    }
    case 'usage':
      yield { type: 'usage', usage: event.usage }
      break
    case 'finish': {
      // OpenRouter repeats the terminal reason in its trailing usage record.
      // Close blocks once while still accepting the final billing observation.
      if (state.finish) {
        if (state.finish !== event.reason)
          throw new Error('Provider emitted conflicting completion reasons')
        return
      }
      for (const index of state.started)
        yield {
          type: 'block-end',
          index,
          block: {
            type: index === 0 ? 'text' : 'reasoning',
            text: index === 0 ? state.text : state.reasoning,
          },
        }
      for (const [index, call] of toolCalls) {
        yield {
          type: 'block-end',
          index: index + 2,
          block: {
            type: 'tool-call',
            id: call.id as never,
            name: call.name,
            arguments: call.arguments,
          },
        }
      }
      state.finish = event.reason
      break
    }
  }
}

/** Classify one transport-layer failure. */
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
      failure: { message: 'Provider transport or stream validation failed', code: 'TRANSPORT' },
    },
  }
}

/** Classify one HTTP failure by status band. */
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
