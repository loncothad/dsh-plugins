/** Authenticated catalog pages expose capability metadata, never provider credentials. */
import type {
  RemoteResult,
  TypertCodec,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import type { MediaCatalogModel, MediaModality, MediaParameter } from './media.ts'
import { mediaSchema } from './schema.ts'
export type MediaCatalogNamespace = 'falMediaCatalog' | 'openrouterMediaCatalog'
export type MediaCatalogSort = 'provider' | 'newest' | 'name'
export interface MediaCatalogPage {
  models: MediaCatalogModel[]
  total: number
  next?: number
}
export interface MediaCatalogRemote {
  list(
    output: MediaModality,
    query: string,
    offset: number,
    sort: MediaCatalogSort,
  ): Promise<RemoteResult<MediaCatalogPage>>
  describe(id: string): Promise<RemoteResult<MediaCatalogModel>>
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    falMediaCatalog: MediaCatalogRemote
    openrouterMediaCatalog: MediaCatalogRemote
  }
}
const outputs = new Set(['text', 'image', 'video', 'audio', '3d'])
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid media catalog')
  return value as Record<string, unknown>
}
const string = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || value.length > max)
    throw new TypeError('Invalid media catalog text')
  return value
}
export const catalogOutput = (value: unknown): MediaModality => {
  if (typeof value !== 'string' || !outputs.has(value)) throw new TypeError('Invalid media output')
  return value as MediaModality
}
export const catalogOffset = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 100000)
    throw new TypeError('Invalid catalog offset')
  return Number(value)
}
export const catalogSort = (value: unknown): MediaCatalogSort => {
  if (value !== 'provider' && value !== 'newest' && value !== 'name')
    throw new TypeError('Invalid media catalog sort')
  return value
}
export function parseMediaCatalogPage(value: unknown): MediaCatalogPage {
  const page = object(value)
  if (!Array.isArray(page.models) || page.models.length > 100)
    throw new TypeError('Invalid media catalog page')
  const models = page.models.map((item) => {
    const row = object(item)
    if (!Array.isArray(row.outputs) || !row.outputs.length || row.outputs.length > 5)
      throw new TypeError('Invalid catalog outputs')
    const inputs = row.inputs
    if (
      inputs !== undefined &&
      (!Array.isArray(inputs) ||
        inputs.length > 5 ||
        inputs.some(
          (kind) =>
            typeof kind !== 'string' || !['text', 'image', 'video', 'audio', '3d'].includes(kind),
        ))
    )
      throw new TypeError('Invalid catalog inputs')
    let parameters: Record<string, MediaParameter> | undefined
    if (row.parameters !== undefined) {
      const entries = Object.entries(object(row.parameters))
      if (entries.length > 32 || JSON.stringify(row.parameters).length > 16384)
        throw new TypeError('Invalid catalog parameter budget')
      parameters = Object.fromEntries(
        entries.map(([key, value]) => {
          string(key, 128)
          const parameter = object(value),
            type = parameter.type
          if (type !== 'string' && type !== 'number' && type !== 'boolean')
            throw new TypeError('Invalid catalog parameter type')
          const values = parameter.values
          if (
            values !== undefined &&
            (!Array.isArray(values) ||
              values.length > 64 ||
              values.some(
                (item) =>
                  typeof item !== type ||
                  (typeof item === 'number' && !Number.isFinite(item)) ||
                  (typeof item === 'string' && item.length > 128),
              ))
          )
            throw new TypeError('Invalid catalog parameter values')
          return [key, { type, ...(Array.isArray(values) ? { values } : {}) }]
        }),
      )
    }
    return {
      id: string(row.id, 512),
      name: string(row.name, 512),
      outputs: row.outputs.map(catalogOutput),
      ...(Array.isArray(inputs) ? { inputs: inputs as MediaCatalogModel['inputs'] } : {}),
      ...(row.description !== undefined ? { description: string(row.description, 8192) } : {}),
      ...(row.pricing !== undefined ? { pricing: string(row.pricing, 8192) } : {}),
      ...(parameters ? { parameters } : {}),
      ...(row.protocol !== undefined ? { protocol: parseProtocol(row.protocol) } : {}),
      ...(row.inputSchema !== undefined ? { inputSchema: mediaSchema(row.inputSchema) } : {}),
      ...(row.outputSchema !== undefined ? { outputSchema: mediaSchema(row.outputSchema) } : {}),
      ...(row.fetchedAt !== undefined ? { fetchedAt: parseTimestamp(row.fetchedAt) } : {}),
      ...(row.releasedAt !== undefined ? { releasedAt: parseTimestamp(row.releasedAt) } : {}),
      ...(row.updatedAt !== undefined ? { updatedAt: parseTimestamp(row.updatedAt) } : {}),
      ...(row.unavailableReason !== undefined
        ? { unavailableReason: string(row.unavailableReason, 2048) }
        : {}),
    }
  })
  return {
    models,
    total: catalogOffset(page.total),
    ...(page.next !== undefined ? { next: catalogOffset(page.next) } : {}),
  }
}
export function mediaCatalogContribution(
  namespace: MediaCatalogNamespace,
): TypertRemoteContribution {
  const codec = (symbol: string, parse: (value: unknown) => unknown): TypertCodec => ({
    mode: 'strict',
    typeSymbol: `@loncothad/dsh-media-gen/catalog#${symbol}`,
    create: () => ({ parse }),
  })
  return {
    package: `@loncothad/dsh-media-gen.${namespace}`,
    descriptors: [
      {
        id: `${namespace}/list`,
        namespace,
        service: namespace,
        method: 'list',
        invocation: { kind: 'direct' },
        parameters: [
          { name: 'output', wire: 'output', source: 'json', codec: codec('Output', catalogOutput) },
          {
            name: 'query',
            wire: 'query',
            source: 'json',
            codec: codec('Query', (value) => string(value, 256)),
          },
          { name: 'offset', wire: 'offset', source: 'json', codec: codec('Offset', catalogOffset) },
          {
            name: 'sort',
            wire: 'sort',
            source: 'json',
            codec: codec('Sort', catalogSort),
          },
        ],
        result: codec('Page', parseMediaCatalogPage),
      },
      {
        id: `${namespace}/describe`,
        namespace,
        service: namespace,
        method: 'describe',
        invocation: { kind: 'direct' },
        parameters: [
          {
            name: 'id',
            wire: 'id',
            source: 'json',
            codec: codec('Id', (value) => string(value, 512)),
          },
        ],
        result: codec(
          'Model',
          (value) => parseMediaCatalogPage({ models: [value], total: 1 }).models[0]!,
        ),
      },
    ],
  }
}
function parseProtocol(value: unknown): NonNullable<MediaCatalogModel['protocol']> {
  if (
    typeof value !== 'string' ||
    !['chat', 'video', 'speech', 'transcription', 'fal'].includes(value)
  )
    throw new TypeError('Invalid media protocol')
  return value as NonNullable<MediaCatalogModel['protocol']>
}
function parseTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new TypeError('Invalid catalog timestamp')
  return Number(value)
}
