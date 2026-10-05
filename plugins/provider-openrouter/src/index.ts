import {
  brokerFetch,
  configEntry,
  credentialValue,
  editableConfig,
  managedApply,
  optionalString,
} from '@loncothad/dsh-plugin-runtime'
import { type FilterMetadata, type ModelFilters, matchesModelFilters } from './model-filters.ts'
/**
 * OpenRouter provider for dsh: OpenRouter's OpenAI-compatible API as a
 * first-class chat provider with the full live model catalog (per-model
 * reasoning efforts, pricing, display names; the decision-model seed
 * anchors offline use), plus its media-generation models behind the
 * shared media surfaces. The upstream provider can be pinned
 * (`/openrouter-provider`): every request then carries OpenRouter's
 * `provider: {order, allow_fallbacks: false}` routing preference and the
 * model window's group header shows the pin live.
 *
 * @module @loncothad/dsh-provider-openrouter
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'
import type { CatalogModel } from '@loncothad/dsh-llm-openai-compat'
import { OpenAICompatAdapter, toModelReasoning } from '@loncothad/dsh-llm-openai-compat'
import type { MediaCatalogModel, MediaFetch } from '@loncothad/dsh-media-gen'
import {
  modelDefaults,
  registerMediaCatalog,
  registerMediaSurfaces,
} from '@loncothad/dsh-media-gen'
import { OPENROUTER_MODELS_TTL_MS, OPENROUTER_MODELS_URL, parseModelsResponse } from './catalog.ts'
import { OpenRouterMediaGenerator } from './media.ts'
import { parseVideoModels } from './video-catalog.ts'

export * from './catalog.ts'
export * from './endpoints.ts'
export * from './media.ts'

/** OpenRouter endpoint; `/chat/completions` is the operation. */
export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

/** Attribution headers OpenRouter requests for app identification. */
export const OPENROUTER_ATTRIBUTION_HEADERS: Readonly<Record<string, string>> = {
  'http-referer': 'https://github.com/loncothad/dsh-plugins',
  'x-title': 'DeepSeek Harness dsh-plugins',
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'provider-openrouter'

/** The seams this provider registers into. */
export const inject = ['llm', 'tools', 'skills', 'commands']

/** Plugin config. */
export interface Config extends ModelFilters {
  /** OpenRouter key. Falls back to `$OPENROUTER_API_KEY`. */
  requestTimeoutMs?: number
  apiKey?: string
  credentialSource?: 'stored' | 'broker'
  secretReference?: string
  brokerOrigins?: string[]
  /** Chat-completions endpoint override. */
  endpoint?: string
  /** Extra catalog model ids (comma-separated) merged into the chat route. */
  extraModels?: string
  /** Upstream provider pinned for every request (OpenRouter routing); empty = let OpenRouter choose. */
  pinnedProvider?: Volatile<string>
  /** Canonical model id to exact OpenRouter upstream slug. */
  modelProviders?: Record<string, string>
  /** Restrict all requests to zero data retention endpoints. */
  zeroDataRetention?: boolean
  /** Exclude providers that collect request data. */
  denyDataCollection?: boolean
  /** Where generated media is written (default `openrouter-media/`). */
  mediaOutDir?: string
  /** Voice for speech/audio-output models (where supported). */
  audioVoice?: string
  /** Default media model when a generation names none. */
  imageModel?: string
  audioModel?: string
  textMediaModel?: string
  videoModel?: string
  videoEndpoint?: string
  videoPollMs?: number
  mediaModelOptions?: Record<string, Record<string, unknown>>
  mediaOutputs?: import('@loncothad/dsh-media-gen').MediaModality[]
  mediaEnabled?: boolean
  mediaTools?: boolean
  mediaSkills?: boolean
  mediaCommands?: boolean
  mediaTimeoutMs?: number
  maxInputBytes?: number
  maxOutputBytes?: number
  maxFiles?: number
  imageBudgetTokens?: number
}

const BaseConfig = z.object({
  modelFiltersEnabled: z
    .boolean()
    .default(false)
    .description('Filter the chat model picker. Existing selected models remain callable.'),
  maxInputPrice: z
    .number()
    .min(0)
    .description(
      'Maximum advertised input price, USD per million tokens. Unset means no price filter.',
    ),
  maxOutputPrice: z
    .number()
    .min(0)
    .description('Maximum advertised output price, USD per million tokens.'),
  minContextWindow: z.number().step(1).min(1).description('Minimum context window in tokens.'),
  maxCatalogAgeDays: z
    .number()
    .step(1)
    .min(1)
    .description(
      'Only models listed on OpenRouter within this many days. Listing date is not necessarily release date.',
    ),
  modelVendors: z
    .array(z.string())
    .default([])
    .description('Optional vendor IDs, one per line, such as openai or google.'),
  includeUnknownModelMetadata: z
    .boolean()
    .default(false)
    .description('Keep models whose metadata required by an active filter is unknown.'),
  requestTimeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .max(900000)
    .default(300000)
    .description(
      'Chat request deadline in milliseconds. Configuration replacement cancels in-flight requests.',
    ),
  credentialSource: z
    .union(['stored', 'broker'])
    .default('stored')
    .description(
      'Stored key uses this profile’s key or host environment. Broker resolves a scoped reference at HTTPS dispatch and never falls back to a stored key.',
    ),
  secretReference: z
    .string()
    .description('Secrets Broker reference ID authorized for the openrouter consumer.'),
  brokerOrigins: z
    .array(z.string())
    .default(['https://openrouter.ai'])
    .description(
      'Explicit HTTPS origins permitted to receive the broker credential. Include a custom API origin only deliberately; credentials are removed for all other origins.',
    ),
  apiKey: z
    .string()
    .role('secret')
    .description('OpenRouter API key; empty falls back to $OPENROUTER_API_KEY.'),
  endpoint: z.string().description('Chat-completions endpoint override.'),
  extraModels: z
    .string()
    .description('Extra chat model ids (comma-separated) merged into the route.'),
  pinnedProvider: z
    .string()
    .volatile()
    .description('Upstream provider pinned for every request (empty = let OpenRouter choose).'),
  modelProviders: z
    .dict(z.string())
    .description('Per-model upstream provider slugs; models keep their canonical IDs.'),
  zeroDataRetention: z
    .boolean()
    .default(false)
    .description('Require zero data retention endpoints for every request.'),
  denyDataCollection: z
    .boolean()
    .default(false)
    .description('Exclude providers that collect request data.'),
  mediaOutDir: z.string().description('Directory generated media is written to.'),
  audioVoice: z.string().description('Voice for speech/audio-output models.'),
  imageModel: z.string().description('Default image-output model.'),
  audioModel: z.string().description('Default audio-output model.'),
  textMediaModel: z
    .string()
    .description('Default media understanding model for text output from images, audio, or video.'),
  videoModel: z
    .string()
    .description('Default video-generation model from the OpenRouter video catalog.'),
  videoEndpoint: z
    .string()
    .default('https://openrouter.ai/api/v1/videos')
    .description(
      'Dedicated asynchronous video-generation endpoint. Set explicitly when using a custom gateway.',
    ),
  videoPollMs: z
    .number()
    .step(1)
    .min(100)
    .max(60000)
    .default(30000)
    .description(
      'Video job polling interval in milliseconds. Aborting local waiting does not cancel a remote job; retain its reported identity before retrying.',
    ),
  mediaModelOptions: z
    .dict(z.dict(z.any()))
    .description(
      'Saved parameter defaults keyed by exact model ID, for example {"vendor/video": {"duration": 4, "resolution": "720p"}}. Per-call options override individual keys. Advertised constraints are checked before dispatch. Maximum 32 KiB per model and 512 KiB total.',
    ),
  mediaOutputs: z
    .array(z.union(['text', 'image', 'video', 'audio']))
    .default(['text', 'image', 'video', 'audio'])
    .description('Enabled media tasks. Disabled outputs are rejected before inference.'),
  mediaEnabled: z
    .boolean()
    .default(true)
    .description('Enable media tools, skill, and commands independently of chat-provider routing.'),
  mediaTools: z
    .boolean()
    .default(true)
    .description('Expose the model-callable openrouter_generate tool.'),
  mediaSkills: z
    .boolean()
    .default(true)
    .description('Expose built-in media instructions when the generation tool is enabled.'),
  mediaCommands: z
    .boolean()
    .default(true)
    .description('Expose the human /openrouter-models and /openrouter-media commands.'),
  mediaTimeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .max(3600000)
    .default(300000)
    .description('Deadline for inference, downloads, and file publication in milliseconds.'),
  maxInputBytes: z
    .number()
    .step(1)
    .min(1)
    .max(1073741824)
    .default(67108864)
    .description('Aggregate local/inline input-byte limit (64 MiB by default).'),
  maxOutputBytes: z
    .number()
    .step(1)
    .min(1)
    .max(1073741824)
    .default(134217728)
    .description('Aggregate output-byte limit (128 MiB by default).'),
  maxFiles: z
    .number()
    .step(1)
    .min(1)
    .max(64)
    .default(8)
    .description('Maximum output artifacts per generation.'),
  imageBudgetTokens: z
    .number()
    .step(1)
    .min(1)
    .description(
      'Explicit conservative token reservation per retained image when using the evidence compactor. This is an operator estimate, not provider billing. Unknown image pricing otherwise prevents compactor admission.',
    ),
})

/** Deterministic hooks for tests. */
export interface OpenRouterInternals {
  fetch?: MediaFetch
  now?: () => number
}

/** The routing preference body field for a pinned upstream provider. */
export function providerPreference(pin: string | undefined): Record<string, unknown> | undefined {
  return pin !== undefined && pin.length > 0
    ? { provider: { order: [pin], allow_fallbacks: false } }
    : undefined
}

/** Per-model choice takes priority over the global pin; privacy constraints always apply. */
export function routingPreference(
  config: Config,
  model: string | undefined,
  globalPin?: string,
): Record<string, unknown> | undefined {
  const pin =
    model !== undefined ? (optionalString(config.modelProviders?.[model]) ?? globalPin) : globalPin
  const preference = {
    ...(pin ? { order: [pin], allow_fallbacks: false } : {}),
    ...(config.zeroDataRetention ? { zdr: true } : {}),
    ...(config.denyDataCollection ? { data_collection: 'deny' } : {}),
  }
  return Object.keys(preference).length ? { provider: preference } : undefined
}

/** The TTL-cached catalog: the public live list, retaining actual observations on refresh failure. */
export class OpenRouterCatalog {
  private cache:
    | { chat: readonly CatalogModel[]; media: readonly MediaCatalogModel[]; fetchedAt: number }
    | undefined
  private videoCache: { models: MediaCatalogModel[]; fetchedAt: number } | undefined
  private readonly audioCache = new Map<
    string,
    { models: MediaCatalogModel[]; fetchedAt: number }
  >()

  constructor(
    private readonly options: {
      fetch?: MediaFetch
      now?: () => number
      extraModels?: readonly CatalogModel[]
      videoModelsUrl?: string
    } = {},
  ) {}

  /** Chat-route models: the live list plus explicit operator extras. */
  async chatModels(signal?: AbortSignal): Promise<readonly CatalogModel[]> {
    const live = await this.live(signal)
    const base = live?.chat ?? []
    const seen = new Set(base.map((model) => model.id))
    const extras = (this.options.extraModels ?? []).filter((model) => !seen.has(model.id))
    return [...base, ...extras]
  }

  /** Media models (image/audio output); empty while the live list is unavailable. */
  async mediaModels(signal?: AbortSignal): Promise<readonly MediaCatalogModel[]> {
    const live = await this.live(signal)
    const models = new Map((live?.media ?? []).map((model) => [model.id, model]))
    for (const model of await this.videoModels(signal)) {
      const existing = models.get(model.id)
      models.set(
        model.id,
        existing
          ? {
              ...existing,
              ...model,
              outputs: [...new Set([...model.outputs, ...existing.outputs])],
            }
          : model,
      )
    }
    for (const protocol of ['speech', 'transcription'] as const)
      for (const model of await this.audioModels(protocol, signal)) models.set(model.id, model)
    return [...models.values()]
  }
  private async audioModels(
    protocol: 'speech' | 'transcription',
    signal?: AbortSignal,
  ): Promise<MediaCatalogModel[]> {
    const now = this.options.now?.() ?? Date.now(),
      cached = this.audioCache.get(protocol)
    if (cached && now - cached.fetchedAt < OPENROUTER_MODELS_TTL_MS) return cached.models
    try {
      const response = await (this.options.fetch ?? fetch)(
        `${OPENROUTER_MODELS_URL}?output_modalities=${protocol}`,
        {
          headers: { accept: 'application/json' },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
            : AbortSignal.timeout(15000),
        },
      )
      if (!response.ok) throw new Error('Audio catalog unavailable')
      const models = parseModelsResponse(await response.json(), now).media.filter(
        (model) => model.protocol === protocol,
      )
      this.audioCache.set(protocol, { models, fetchedAt: now })
      return models
    } catch {
      signal?.throwIfAborted()
      return cached?.models ?? []
    }
  }
  private async videoModels(signal?: AbortSignal): Promise<MediaCatalogModel[]> {
    const now = this.options.now?.() ?? Date.now()
    if (this.videoCache && now - this.videoCache.fetchedAt < OPENROUTER_MODELS_TTL_MS)
      return this.videoCache.models
    try {
      const response = await (this.options.fetch ?? fetch)(
        this.options.videoModelsUrl ?? 'https://openrouter.ai/api/v1/videos/models',
        {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
            : AbortSignal.timeout(10000),
          headers: { accept: 'application/json' },
        },
      )
      if (!response.ok) throw new Error('Video catalog unavailable')
      const models = parseVideoModels(await response.json())
      this.videoCache = { models, fetchedAt: now }
      return models
    } catch {
      signal?.throwIfAborted()
      return this.videoCache?.models ?? []
    }
  }

  private async live(
    signal?: AbortSignal,
  ): Promise<{ chat: readonly CatalogModel[]; media: readonly MediaCatalogModel[] } | undefined> {
    const now = this.options.now?.() ?? Date.now()
    if (this.cache !== undefined && now - this.cache.fetchedAt < OPENROUTER_MODELS_TTL_MS) {
      return this.cache
    }
    try {
      const response = await (this.options.fetch ?? fetch)(OPENROUTER_MODELS_URL, {
        headers: { accept: 'application/json' },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`the models request failed (HTTP ${response.status})`)
      const parsed = parseModelsResponse(await response.json())
      this.cache = { ...parsed, fetchedAt: now }
      return this.cache
    } catch {
      signal?.throwIfAborted()
      // Offline or malformed: the chat seed keeps routing; media waits.
      return this.cache
    }
  }
}

/** Register the chat route, model discovery, the pin, and the media surfaces. */
function activate(ctx: Context, config: Config, internals: OpenRouterInternals = {}): void {
  const defaults = modelDefaults(config.mediaModelOptions)
  config = {
    ...config,
    apiKey: optionalString(config.apiKey),
    endpoint: optionalString(config.endpoint),
  }

  const reference = () =>
    config.credentialSource === 'broker' ? optionalString(config.secretReference) : undefined
  if (config.credentialSource === 'broker' && !reference())
    throw new Error('Choose an OpenRouter broker secret reference')
  const transport = brokerFetch(ctx, {
    consumer: 'openrouter',
    reference,
    origins: config.brokerOrigins ?? ['https://openrouter.ai'],
    scheme: 'Bearer',
    fetch: internals.fetch,
  })
  const apiKey = () =>
    credentialValue(ctx, () =>
      reference() ? 'broker-managed' : (config.apiKey ?? process.env.OPENROUTER_API_KEY),
    )
  const pinnedProvider = () => {
    const pin = config.pinnedProvider?.get()
    return pin !== undefined && pin.length > 0 ? pin : undefined
  }
  const extraModels = (config.extraModels ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .map((id) => ({ id }))
  const lifetime = new AbortController()
  ctx.effect(
    () => () => lifetime.abort(new Error('OpenRouter provider disposed')),
    'openrouter: cancel active requests',
  )
  const catalog = new OpenRouterCatalog({
    ...(internals.fetch !== undefined || reference() ? { fetch: transport } : {}),
    ...(internals.now !== undefined ? { now: internals.now } : {}),
    extraModels,
    videoModelsUrl: `${(config.videoEndpoint ?? 'https://openrouter.ai/api/v1/videos').replace(/\/$/, '')}/models`,
  })
  ctx.provide('openrouterDecisions', {
    request: async (body: Record<string, unknown>, signal: AbortSignal) => {
      if (typeof body.model !== 'string') throw new Error('Choose an OpenRouter decision model')
      if (routingPreference(config, body.model, pinnedProvider()))
        throw new Error(
          'OpenRouter Decisions cannot honor configured chat upstream or privacy filters. This decision request is blocked; no preferences were relaxed.',
        )
      const key = apiKey()
      if (!key) throw new Error('Configure credentials in Plugins > OpenRouter')
      return transport('https://openrouter.ai/api/alpha/decisions', {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          ...OPENROUTER_ATTRIBUTION_HEADERS,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          signal,
          lifetime.signal,
          AbortSignal.timeout(config.requestTimeoutMs ?? 60000),
        ]),
      })
    },
  })
  // The registry snapshots providerInfo at registration, so the pin rides
  // the group header by re-registering the route when the pin changes.
  // The catalog (and its TTL cache) is shared across the swap.
  let disposeAdapter: (() => void) | undefined
  const mountAdapter = () => {
    disposeAdapter?.()
    const pin = pinnedProvider()
    const adapter = new OpenAICompatAdapter({
      resolveAttachments: () => ctx.get('attachments'),
      imagePricing: () =>
        config.imageBudgetTokens
          ? {
              priceImages: (images) =>
                images.map((image) => ({
                  visualTokens: image.offloaded ? 0 : config.imageBudgetTokens!,
                  text: '',
                })),
            }
          : undefined,
      lifetime: lifetime.signal,
      timeoutMs: config.requestTimeoutMs,
      provider: 'openrouter',
      providerName: pin !== undefined ? `OpenRouter · ${pin}` : 'OpenRouter',
      endpoint: config.endpoint ?? OPENROUTER_ENDPOINT,
      apiKey,
      models: [], // resolved per call through the registration below
      headers: OPENROUTER_ATTRIBUTION_HEADERS,
      extraBody: (options) => routingPreference(config, options.model, pinnedProvider()),
      fetch: transport,
    })
    // The catalog is advisory; the adapter serves the live list through
    // listModels/resolveModel by overriding on this instance.
    serveCatalog(adapter, catalog, config)
    disposeAdapter = ctx.llm.registerAdapter(['openrouter'], adapter)
  }
  mountAdapter()

  ctx.llm.registerModelDiscovery('openrouter', async () => {
    const models = await catalog.chatModels()
    return models.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    }))
  })

  ctx.commands.register({
    name: 'openrouter-provider',
    description:
      'Show or pin the upstream provider OpenRouter routes every request to (off lets OpenRouter choose)',
    input: { hint: '[provider|off]' },
    handler: async (invocation): Promise<CommandResult> => {
      const argument = invocation.rawInput.trim()
      if (argument.length === 0) {
        const pin = pinnedProvider()
        return {
          kind: 'success',
          text:
            pin !== undefined
              ? `Requests are pinned to the upstream provider ${pin} (no fallbacks).`
              : 'OpenRouter chooses the upstream provider per request. Name one to pin it.',
        }
      }
      if (argument.toLowerCase() === 'off') {
        try {
          await persistPin(ctx, undefined)
        } catch {
          return {
            kind: 'error',
            text: 'The provider preference could not be saved; use this provider’s Plugins configuration page.',
          }
        }
        return {
          kind: 'success',
          text: 'The upstream provider pin is off; OpenRouter routes per request again.',
        }
      }
      try {
        await persistPin(ctx, argument)
      } catch {
        return {
          kind: 'error',
          text: 'The provider preference could not be saved; use this provider’s Plugins configuration page.',
        }
      }
      return {
        kind: 'success',
        text: `Requests are now pinned to the upstream provider ${argument} (no fallbacks).`,
      }
    },
  })

  registerMediaCatalog(ctx, 'openrouterMediaCatalog', (signal) => catalog.mediaModels(signal))
  if (config.mediaEnabled !== false)
    registerMediaSurfaces(ctx, {
      provider: 'openrouter',
      label: 'OpenRouter',
      toolsEnabled: config.mediaTools,
      enabledOutputs: config.mediaOutputs,
      skillsEnabled: config.mediaSkills,
      commandsEnabled: config.mediaCommands,
      timeoutMs: config.mediaTimeoutMs,
      maxInputBytes: config.maxInputBytes,
      maxOutputBytes: config.maxOutputBytes,
      maxFiles: config.maxFiles,
      outDir: config.mediaOutDir ?? 'openrouter-media',
      models: (signal) => catalog.mediaModels(signal),
      defaultOptions: (model) => (Object.hasOwn(defaults, model) ? defaults[model] : undefined),
      defaultModel: (modality) =>
        modality === 'text'
          ? config.textMediaModel
          : modality === 'video'
            ? config.videoModel
            : modality === 'audio'
              ? config.audioModel
              : config.imageModel,
      generator: new OpenRouterMediaGenerator({
        apiKey,
        endpoint: config.endpoint ?? OPENROUTER_ENDPOINT,
        videoEndpoint: config.videoEndpoint ?? 'https://openrouter.ai/api/v1/videos',
        videoPollMs: config.videoPollMs,
        maxResponseBytes: config.maxOutputBytes,
        headers: OPENROUTER_ATTRIBUTION_HEADERS,
        ...(config.audioVoice !== undefined ? { audioVoice: () => config.audioVoice } : {}),
        extraBody: (request) => routingPreference(config, request.model, pinnedProvider()),
        ...(internals.fetch !== undefined || reference() ? { fetch: transport } : {}),
      }),
      ...(internals.fetch !== undefined || reference() ? { fetch: transport } : {}),
    })
}

/**
 * Persist a provider pin through the config editor so it survives
 * restarts. The edit callback returns the whole entry config because the
 * editor replaces, not merges.
 */
async function persistPin(ctx: Context, pin: string | undefined): Promise<void> {
  const entry = configEntry(ctx)
  const editor = ctx.get('configEditor')
  if (entry === undefined || editor === undefined) {
    throw new Error('The profile configuration editor is unavailable')
  }
  await editor.edit(entry, (current) => ({ ...current, pinnedProvider: pin ?? '' }))
}

/**
 * Bind one OpenAICompatAdapter instance to the live catalog: its static
 * options carry no models, so these overrides serve listModels and
 * resolveModel from the catalog (seed + live + extras).
 */
function serveCatalog(
  adapter: OpenAICompatAdapter,
  catalog: OpenRouterCatalog,
  filters: ModelFilters,
): void {
  adapter.listModels = async (provider) => {
    const models = await catalog.chatModels()
    return models
      .filter((model) =>
        matchesModelFilters(
          model.id,
          (model as CatalogModel & { filterMetadata?: FilterMetadata }).filterMetadata ?? {},
          filters,
        ),
      )
      .map((model) => ({
        provider,
        id: model.id,
        name: model.name ?? model.id,
        ...(model.description !== undefined ? { description: model.description } : {}),
      }))
  }
  adapter.resolveModel = async (provider, model, signal) => {
    const models = await catalog.chatModels(signal)
    const entry = models.find((candidate) => candidate.id === model)
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
}

/** Complete configuration and managed capability lifetime. */
export const Config = editableConfig(BaseConfig)
export const apply = managedApply(BaseConfig, activate)
