/**
 * OpenRouter catalog domain: the public `/api/v1/models` list parsed into
 * chat models (with per-model reasoning efforts and pricing) and media
 * models (image and audio output, with their input transitions and
 * pricing). Pure domain.
 *
 * Item shape (grounded in the live API): id, name, description,
 * context_length, architecture.{input_modalities, output_modalities},
 * supported_parameters, reasoning.{supported_efforts, default_effort},
 * pricing.{prompt, completion} (USD per token strings), alias_target,
 * expiration_date.
 *
 * @module @loncothad/dsh-provider-openrouter/catalog
 */

import type { CatalogModel } from '@loncothad/dsh-llm-openai-compat'
import type { MediaCatalogModel, MediaModality } from '@loncothad/dsh-media-gen'
import { audioSchema } from './audio-schema.ts'
import type { FilterMetadata } from './model-filters.ts'

/** OpenRouter's public model list (no key required). */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

/** Catalog cache lifetime. */
export const OPENROUTER_MODELS_TTL_MS = 300_000

/** One raw catalog item. */
export interface RawOpenRouterModel {
  readonly created?: unknown
  readonly id?: unknown
  readonly name?: unknown
  readonly description?: unknown
  readonly context_length?: unknown
  readonly architecture?: unknown
  readonly supported_parameters?: unknown
  readonly reasoning?: unknown
  readonly pricing?: unknown
  readonly alias_target?: unknown
  readonly expiration_date?: unknown
  readonly architecture_modality?: unknown
  readonly supported_voices?: unknown
}

/** The parsed catalog: chat route models plus media-generation models. */
export interface OpenRouterCatalogModels {
  readonly chat: readonly (CatalogModel & { filterMetadata?: FilterMetadata })[]
  readonly media: readonly MediaCatalogModel[]
}

/**
 * Parse the models response.
 *
 * Filtering follows the catalog's own availability markers: alias entries
 * (`alias_target`, e.g. `~vendor/model-latest`) are pointers at models
 * already listed, and entries with a past `expiration_date` are retired —
 * neither is a distinct usable model. Pricing rides the description so
 * the model picker shows it: `$X/M in · $Y/M out` from the per-token
 * rates; entries whose rates are unknown (`-1`) carry no price line.
 */
export function parseModelsResponse(payload: unknown, now = Date.now()): OpenRouterCatalogModels {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('the OpenRouter models response was not an object')
  }
  const raw = (payload as Record<string, unknown>).data
  if (!Array.isArray(raw)) {
    throw new Error('the OpenRouter models response omitted its data array')
  }
  const chat: (CatalogModel & { filterMetadata?: FilterMetadata })[] = []
  const media: MediaCatalogModel[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const item: RawOpenRouterModel =
      typeof entry === 'object' && entry !== null ? (entry as RawOpenRouterModel) : {}
    const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : undefined
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    // Aliases point at canonical models that are listed on their own.
    if (item.alias_target !== undefined && item.alias_target !== null) continue
    // Retired models keep their entry until the next catalog revision.
    if (expired(item.expiration_date, now)) continue
    const name = typeof item.name === 'string' && item.name.length > 0 ? item.name : id
    const outputs = outputModalities(item.architecture)
    const inputs = inputModalities(item.architecture)
    const price = pricingOf(item, outputs)
    const speech = outputs.includes('speech')
    const transcription = outputs.includes('transcription')
    const mediaOutputs = [
      ...new Set(
        outputs.map((output) =>
          output === 'speech' ? 'audio' : output === 'transcription' ? 'text' : output,
        ),
      ),
    ].filter((output): output is MediaModality =>
      ['text', 'image', 'audio', 'video', '3d'].includes(output),
    )
    if (
      mediaOutputs.some((output) => output !== 'text') ||
      (mediaOutputs.includes('text') && inputs.some((input) => input !== 'text'))
    ) {
      media.push({
        id,
        name,
        ...describe(item.description, price),
        outputs: mediaOutputs,
        inputs: inputs.length > 0 ? inputs : ['text'],
        protocol: speech
          ? 'speech'
          : transcription
            ? 'transcription'
            : mediaOutputs.includes('video')
              ? 'video'
              : 'chat',
        fetchedAt: now,
        ...(speech || transcription
          ? { inputSchema: audioSchema(speech ? 'speech' : 'transcription', item.supported_voices) }
          : {}),
        ...(price !== undefined ? { pricing: price } : {}),
      })
      if (mediaOutputs.some((output) => output !== 'text')) continue
    }
    if (!outputs.includes('text')) continue
    chat.push({
      id,
      filterMetadata: {
        contextWindow:
          typeof item.context_length === 'number' &&
          Number.isFinite(item.context_length) &&
          item.context_length > 0
            ? item.context_length
            : undefined,
        listedAt:
          typeof item.created === 'number' && Number.isFinite(item.created) && item.created >= 0
            ? item.created * 1000
            : undefined,
        ...(() => {
          const prices = item.pricing as Record<string, unknown> | undefined
          const value = (field: string) =>
            (typeof prices?.[field] === 'number' ||
              (typeof prices?.[field] === 'string' && String(prices[field]).trim() !== '')) &&
            Number.isFinite(Number(prices[field])) &&
            Number(prices[field]) >= 0
              ? Number(prices[field]) * 1e6
              : undefined
          return { inputPrice: value('prompt'), outputPrice: value('completion') }
        })(),
      },
      ...(inputs.length
        ? {
            inputModalities: inputs.filter(
              (kind): kind is 'text' | 'image' => kind === 'text' || kind === 'image',
            ),
          }
        : {}),
      ...(positiveInt(item.context_length)
        ? { contextWindow: positiveInt(item.context_length) }
        : {}),
      name,
      ...describe(item.description, price),
      ...reasoningOf(item),
    })
  }
  if (chat.length === 0 && media.length === 0) {
    throw new Error('the OpenRouter models response carried no models')
  }
  return { chat, media }
}

/** Per-model reasoning efforts when OpenRouter discloses them. */
function reasoningOf(item: RawOpenRouterModel): { reasoning?: CatalogModel['reasoning'] } {
  const supported = Array.isArray(item.supported_parameters)
    ? (item.supported_parameters as unknown[]).filter(
        (value): value is string => typeof value === 'string',
      )
    : []
  if (!supported.includes('reasoning_effort')) return {}
  const raw = item.reasoning
  if (typeof raw !== 'object' || raw === null) return {}
  const record = raw as Record<string, unknown>
  const efforts = Array.isArray(record.supported_efforts)
    ? (record.supported_efforts as unknown[])
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .map((id) => ({
          id,
          name: id === 'xhigh' ? 'Extra High' : id.charAt(0).toUpperCase() + id.slice(1),
        }))
    : []
  const defaultEffort =
    typeof record.default_effort === 'string' ? record.default_effort : undefined
  if (efforts.length === 0) return {}
  return {
    reasoning: {
      efforts,
      ...(defaultEffort !== undefined && efforts.some((effort) => effort.id === defaultEffort)
        ? { defaultEffort }
        : {}),
    },
  }
}

/**
 * The price line for one model: per-million-token USD from the per-token
 * rates. Unknown rates (`-1` sentinels, missing fields) yield undefined.
 */
function pricingOf(item: RawOpenRouterModel, outputs: readonly string[]): string | undefined {
  const raw = item.pricing
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (outputs.includes('speech')) {
    const rates = Object.entries(record)
      .filter(([, v]) => typeof v === 'string' && Number.isFinite(Number(v)) && Number(v) > 0)
      .map(
        ([k, v]) => `${k}: $${v} (billing unit not disclosed by this catalog; see model pricing)`,
      )
    return rates.join(' · ') || undefined
  }
  if (outputs.includes('transcription')) {
    const rate = Number(record.prompt)
    return typeof record.prompt === 'string' && Number.isFinite(rate) && rate >= 0
      ? `$${rate}/audio second`
      : undefined
  }
  const input = perMillion(record.prompt)
  const output = perMillion(record.completion)
  if (input === undefined && output === undefined) return undefined
  return [
    ...(input !== undefined ? [`$${input}/M in`] : []),
    ...(output !== undefined ? [`$${output}/M out`] : []),
  ].join(' · ')
}

/** USD per million tokens, rounded for display; `-1` (unknown) is absent. */
function perMillion(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const rate = Number(value)
  if (!Number.isFinite(rate) || rate < 0) return undefined
  const millions = rate * 1_000_000
  const fixed =
    millions >= 100
      ? millions.toFixed(0)
      : millions >= 10
        ? millions.toFixed(1)
        : millions >= 1
          ? millions.toFixed(2)
          : millions.toFixed(3)
  // Trim trailing zeros only when a decimal point exists ('2.00' -> '2').
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}

/** Description with the price line appended, when either exists. */
function describe(description: unknown, price: string | undefined): { description?: string } {
  const squashed =
    typeof description === 'string' && description.length > 0
      ? description.replaceAll('\n', ' ').trim()
      : undefined
  const trimmed =
    squashed !== undefined && squashed.length > 200 ? `${squashed.slice(0, 197)}…` : squashed
  const parts = [
    ...(trimmed !== undefined ? [trimmed] : []),
    ...(price !== undefined ? [price] : []),
  ]
  return parts.length > 0 ? { description: parts.join(' — ') } : {}
}

/** Whether an expiration date exists and has passed. */
function expired(value: unknown, now: number): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  const at = Date.parse(value)
  return Number.isFinite(at) && at < now
}

/** Output modalities from `architecture.output_modalities`. */
function outputModalities(architecture: unknown): readonly string[] {
  return modalitiesOf(architecture, 'output_modalities')
}

/** Input modalities (generation kinds only) from `architecture.input_modalities`. */
function inputModalities(architecture: unknown): readonly ('text' | 'image' | 'video' | 'audio')[] {
  return modalitiesOf(architecture, 'input_modalities').filter(
    (modality): modality is 'text' | 'image' | 'video' | 'audio' =>
      modality === 'text' || modality === 'image' || modality === 'video' || modality === 'audio',
  )
}

function modalitiesOf(architecture: unknown, field: string): readonly string[] {
  if (typeof architecture !== 'object' || architecture === null) return []
  const value = (architecture as Record<string, unknown>)[field]
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}
