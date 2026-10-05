/** fal's documented model search and lazily expanded model schemas. */

import type { MediaCatalogModel, MediaFetch } from '@loncothad/dsh-media-gen'
import { openApiSchema, readMediaResponse } from '@loncothad/dsh-media-gen'
import { transitionsOf } from './registry.ts'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
export const FAL_MODELS_URL = 'https://api.fal.ai/v1/models'
const TTL = 600000

function timestamp(value: unknown): number | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return undefined
  const parsed = Date.parse(value)
  const calendarDate = Date.parse(`${value.slice(0, 10)}T00:00:00Z`)
  return Number.isSafeInteger(parsed) &&
    parsed >= 0 &&
    Number.isFinite(calendarDate) &&
    new Date(calendarDate).toISOString().slice(0, 10) === value.slice(0, 10)
    ? parsed
    : undefined
}

export function parseFalModel(value: unknown, now: number): MediaCatalogModel | undefined {
  const row = object(value),
    metadata = object(row.metadata)
  if (
    typeof row.endpoint_id !== 'string' ||
    row.endpoint_id.length > 512 ||
    metadata.status === 'deprecated' ||
    metadata.kind === 'training'
  )
    return undefined
  const transitions = transitionsOf(String(metadata.category ?? ''))
  if (!transitions) return undefined
  const expanded = row.openapi !== undefined
  const inputSchema = expanded ? openApiSchema(row.openapi) : undefined
  const outputSchema = expanded ? openApiSchema(row.openapi, true) : undefined
  const releasedAt = timestamp(metadata.date),
    updatedAt = timestamp(metadata.updated_at)
  return {
    id: row.endpoint_id,
    name:
      typeof metadata.display_name === 'string'
        ? metadata.display_name.slice(0, 512)
        : row.endpoint_id,
    ...transitions,
    protocol: 'fal',
    fetchedAt: now,
    ...(releasedAt !== undefined ? { releasedAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(typeof metadata.description === 'string'
      ? { description: metadata.description.slice(0, 8192) }
      : {}),
    ...(inputSchema ? { inputSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    ...(expanded && !inputSchema
      ? {
          unavailableReason:
            'This endpoint does not advertise a supported JSON request contract. Realtime, streaming, and webhook-only execution are unavailable through DSH media tools.',
        }
      : {}),
  }
}

export class FalCatalog {
  private cache?: { models: readonly MediaCatalogModel[]; fetchedAt: number }
  private readonly prices = new Map<string, { text?: string; observedAt: number }>()
  private pricingQueue: Promise<unknown> = Promise.resolve()
  private readonly descriptions = new Map<string, { model: MediaCatalogModel; fetchedAt: number }>()
  constructor(
    private readonly options: {
      fetch?: MediaFetch
      now?: () => number
      pages?: number
      apiKey?: () => string | undefined
    } = {},
  ) {}
  async models(signal?: AbortSignal): Promise<readonly MediaCatalogModel[]> {
    const now = this.options.now?.() ?? Date.now()
    if (this.cache && now - this.cache.fetchedAt < TTL) return this.cache.models
    try {
      const models: MediaCatalogModel[] = [],
        seen = new Set<string>(),
        cursors = new Set<string>()
      let cursor: string | undefined
      for (let page = 0; page < (this.options.pages ?? 256); page++) {
        const payload = await this.get(
          { limit: '100', status: 'active', ...(cursor ? { cursor } : {}) },
          signal,
        )
        if (!Array.isArray(payload.models)) throw new Error('fal returned an invalid model page')
        for (const row of payload.models) {
          const model = parseFalModel(row, now)
          if (model && !seen.has(model.id)) {
            models.push(model)
            seen.add(model.id)
          }
        }
        const next = payload.next_cursor
        if (next === undefined || next === null || next === '') {
          this.cache = { models, fetchedAt: now }
          return models
        }
        if (typeof next !== 'string' || next.length > 4096 || cursors.has(next))
          throw new Error('fal returned an invalid pagination cursor')
        cursors.add(next)
        cursor = next
      }
      throw new Error('fal catalog traversal exceeded its configured page limit')
    } catch (error) {
      signal?.throwIfAborted()
      if (this.cache) return this.cache.models
      throw error
    }
  }
  async describe(id: string, signal?: AbortSignal): Promise<MediaCatalogModel> {
    if (!id || id.length > 512) throw new Error('Invalid fal model ID')
    const now = this.options.now?.() ?? Date.now(),
      cached = this.descriptions.get(id)
    if (cached && now - cached.fetchedAt < TTL) return cached.model
    const payload = await this.get({ endpoint_id: id, expand: 'openapi-3.0' }, signal)
    let row = Array.isArray(payload.models)
      ? payload.models.find((value) => object(value).endpoint_id === id)
      : undefined
    if (row && !object(object(row).openapi).paths) {
      const url = new URL('https://fal.ai/api/openapi/queue/openapi.json')
      url.searchParams.set('endpoint_id', id)
      const response = await (this.options.fetch ?? fetch)(url.href, {
        redirect: 'error',
        credentials: 'omit',
        headers: { accept: 'application/json' },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new Error(`fal model schema failed (HTTP ${response.status})`)
      row = {
        ...object(row),
        openapi: JSON.parse(
          new TextDecoder().decode(
            await readMediaResponse(
              response,
              2 * 1024 * 1024,
              signal ?? AbortSignal.timeout(15000),
            ),
          ),
        ),
      }
    }
    let model = row ? parseFalModel(row, now) : undefined
    if (!model) throw new Error('fal does not advertise this media model')
    if (!model.inputSchema && !model.unavailableReason)
      throw new Error('fal has not advertised a supported input schema for this model')
    const pricing = await this.price(id, signal)
    if (pricing) model = { ...model, pricing }
    if (this.descriptions.size >= 64)
      this.descriptions.delete(this.descriptions.keys().next().value!)
    this.descriptions.set(id, { model, fetchedAt: now })
    return model
  }
  async priceModels(
    models: readonly MediaCatalogModel[],
    signal?: AbortSignal,
  ): Promise<readonly MediaCatalogModel[]> {
    if (models.length > 100) throw new Error('Pricing page exceeds its model bound')
    const operation = this.pricingQueue.then(async () => {
      signal?.throwIfAborted()
      const key = this.options.apiKey?.(),
        now = this.options.now?.() ?? Date.now()
      if (!key) return models
      const missing = models.filter(
        (model) => !this.prices.has(model.id) || now - this.prices.get(model.id)!.observedAt >= TTL,
      )
      for (let offset = 0; offset < missing.length; offset += 50) {
        const batch = missing.slice(offset, offset + 50),
          url = new URL('https://api.fal.ai/v1/models/pricing')
        for (const model of batch) url.searchParams.append('endpoint_id', model.id)
        try {
          const deadline = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
            : AbortSignal.timeout(15000)
          const response = await (this.options.fetch ?? fetch)(url.href, {
            redirect: 'error',
            headers: { authorization: `Key ${key}` },
            signal: deadline,
          })
          let rows: unknown[] = []
          if (response.ok) {
            const payload = object(
              JSON.parse(
                new TextDecoder().decode(await readMediaResponse(response, 262144, deadline)),
              ),
            )
            if (Array.isArray(payload.prices)) rows = payload.prices
          } else await response.body?.cancel()
          for (const model of batch) {
            const price = object(rows.find((row) => object(row).endpoint_id === model.id))
            const text =
              typeof price.unit_price === 'number' &&
              Number.isFinite(price.unit_price) &&
              price.unit_price >= 0 &&
              typeof price.unit === 'string' &&
              price.unit.length <= 128 &&
              typeof price.currency === 'string' &&
              price.currency.length <= 16
                ? `${price.currency} ${price.unit_price}/${price.unit}`
                : undefined
            this.prices.set(model.id, { text, observedAt: now })
          }
        } catch {
          signal?.throwIfAborted()
          for (const model of batch) this.prices.set(model.id, { observedAt: now })
        }
      }
      while (this.prices.size > 4096) this.prices.delete(this.prices.keys().next().value!)
      return models.map((model) => ({
        ...model,
        ...(this.prices.get(model.id)?.text ? { pricing: this.prices.get(model.id)!.text } : {}),
      }))
    })
    this.pricingQueue = operation.catch(() => {})
    return operation
  }
  private async price(id: string, signal?: AbortSignal): Promise<string | undefined> {
    const [model] = await this.priceModels([{ id, name: id, outputs: ['image'] }], signal)
    return model?.pricing
  }
  private async get(
    parameters: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url = new URL(FAL_MODELS_URL)
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value)
    const key = this.options.apiKey?.()
    const response = await (this.options.fetch ?? fetch)(url.href, {
      redirect: 'error',
      headers: { accept: 'application/json', ...(key ? { authorization: `Key ${key}` } : {}) },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    })
    if (!response.ok)
      throw new Error(
        `fal model catalog failed (HTTP ${response.status}). Check the configured key's model-metadata permissions.`,
      )
    return object(
      JSON.parse(
        new TextDecoder().decode(
          await readMediaResponse(response, 2 * 1024 * 1024, signal ?? AbortSignal.timeout(15000)),
        ),
      ),
    )
  }
}
