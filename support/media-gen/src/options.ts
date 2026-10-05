import type { MediaCatalogModel } from './media.ts'
import { mediaProperties, validateMediaBody } from './schema.ts'
/** Operator defaults and per-call overrides share one bounded JSON validation boundary. */
export type MediaModelDefaults = Readonly<Record<string, Readonly<Record<string, unknown>>>>
const object = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [null, Object.prototype].includes(Object.getPrototypeOf(value))
const reserved = new Set([
  'model',
  'prompt',
  'inputs',
  'output',
  'messages',
  'modalities',
  'stream',
  'provider',
  'image_url',
  'image_urls',
  'audio_url',
  'video_url',
])
function parameters(value: Record<string, unknown>): void {
  let nodes = 0
  function visit(item: unknown, depth: number) {
    if (++nodes > 4096 || depth > 32) throw new Error('Media options exceed their structural limit')
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      return
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1)
      return
    }
    if (object(item)) {
      Object.values(item).forEach((child) => {
        visit(child, depth + 1)
      })
      return
    }
    throw new Error('Media options must contain finite JSON values')
  }
  visit(value, 0)
}
function defaultsOnly(value: Record<string, unknown>): void {
  if (Object.keys(value).some((key) => reserved.has(key)))
    throw new Error('Media defaults cannot override model routing, prompts, or source inputs')
  parameters(value)
}
export function modelDefaults(value: unknown): MediaModelDefaults {
  if (value === undefined) return {}
  if (!object(value) || Object.keys(value).length > 512)
    throw new Error('Media model options must map at most 512 model IDs to option objects')
  const result: Record<string, Readonly<Record<string, unknown>>> = {}
  for (const [id, options] of Object.entries(value)) {
    if (!id.trim() || id.length > 512 || !object(options) || Object.keys(options).length > 128)
      throw new Error('Invalid media model option defaults')
    defaultsOnly(options)
    Object.defineProperty(result, id, { value: structuredClone(options), enumerable: true })
    const json = JSON.stringify(options)
    if (new TextEncoder().encode(json).byteLength > 32768)
      throw new Error('Media model options exceed the 32 KiB per-model limit')
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 524288)
    throw new Error('Media model defaults exceed the 512 KiB limit')
  return result
}
export function mergeMediaOptions(
  defaults: Readonly<Record<string, unknown>> | undefined,
  overrides: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (defaults === undefined && overrides === undefined) return undefined
  if (
    (defaults !== undefined && !object(defaults)) ||
    (overrides !== undefined && !object(overrides))
  )
    throw new Error('Media options must be JSON objects')
  if (defaults) defaultsOnly(defaults)
  if (overrides) parameters(overrides)
  const merged = { ...defaults, ...overrides }
  if (
    Object.keys(merged).length > 128 ||
    new TextEncoder().encode(JSON.stringify(merged)).byteLength > 32768
  )
    throw new Error('Media request options exceed their limit')
  return structuredClone(merged)
}

export function validateModelOptions(
  model: MediaCatalogModel,
  options: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (model.inputSchema && options) {
    try {
      validateMediaBody(
        {
          type: 'object',
          properties: mediaProperties(model.inputSchema),
          ...(model.inputSchema.definitions ? { definitions: model.inputSchema.definitions } : {}),
          additionalProperties: true,
        },
        options,
      )
    } catch (error) {
      return error instanceof Error ? error.message : 'Invalid saved model parameters'
    }
  }
  for (const [name, parameter] of Object.entries(model.parameters ?? {})) {
    const value = options?.[name]
    if (value === undefined) continue
    if (
      typeof value !== parameter.type ||
      (typeof value === 'number' && !Number.isFinite(value)) ||
      (parameter.values && !parameter.values.includes(value as string | number | boolean))
    )
      return `${model.id}: unsupported ${name}; expected ${parameter.values ? parameter.values.join(', ') : parameter.type}.`
  }
  return undefined
}
