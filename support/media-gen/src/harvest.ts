/** Normalize declared output fields; echoed inputs, prompts and metadata are never artifacts. */
import { createHash } from 'node:crypto'
import type { MediaModality, MediaSchema } from './media.ts'
import { mimeOfUrl, modalityOfMime } from './media.ts'
export interface HarvestedArtifact {
  readonly url?: string
  readonly base64?: string
  readonly mime: string
  readonly modality: MediaModality
}
const KEYS: Readonly<Record<string, MediaModality | undefined>> = {
  image_url: 'image',
  image: 'image',
  images: 'image',
  output_image: 'image',
  masks: 'image',
  segmentation_masks: 'image',
  video_url: 'video',
  video: 'video',
  videos: 'video',
  audio_url: 'audio',
  audio: 'audio',
  audios: 'audio',
  mesh: '3d',
  model_mesh: '3d',
  model_glb: '3d',
  model_obj: '3d',
  glb: '3d',
  gltf: '3d',
  obj: '3d',
  stl: '3d',
  point_cloud: '3d',
  gaussian_splats: '3d',
  url: undefined,
  file_url: undefined,
  file: undefined,
  files: undefined,
  output: undefined,
  outputs: undefined,
  result: undefined,
  results: undefined,
  layers: undefined,
}
export function harvestMedia(
  raw: unknown,
  output?: MediaModality,
  outputSchema?: MediaSchema,
): readonly HarvestedArtifact[] {
  const found: HarvestedArtifact[] = [],
    seen = new Set<string>()
  let nodes = 0
  const push = (artifact: HarvestedArtifact | undefined) => {
    if (!artifact) return
    const key =
      artifact.url ??
      `data:${artifact.mime}:${createHash('sha256').update(artifact.base64!).digest('hex')}`
    if (!seen.has(key)) {
      seen.add(key)
      found.push(artifact)
    }
    if (found.length > 64) throw new Error('Generated media exceeds the artifact parser limit')
  }
  function asset(
    value: string,
    hint?: MediaModality,
    declared?: string,
  ): HarvestedArtifact | undefined {
    if (value.startsWith('data:')) {
      const match = /^data:([^;,]+);base64,([a-z0-9+/]+={0,2})$/i.exec(value)
      if (!match || match[2]!.length % 4) return undefined
      const mime = match[1]!.toLowerCase(),
        modality = modalityOfMime(mime)
      return modality ? { mime, modality, base64: match[2]! } : undefined
    }
    if (!/^https?:\/\//i.test(value)) return undefined
    const mime =
      declared && declared !== 'application/octet-stream'
        ? declared
        : (mimeOfUrl(value) ?? declared ?? 'application/octet-stream')
    const modality = modalityOfMime(mime) ?? hint
    return modality && modality !== 'text' ? { url: value, mime, modality } : undefined
  }
  function visit(value: unknown, hint?: MediaModality, depth = 0) {
    if (++nodes > 8192 || depth > 16)
      throw new Error('Generated media exceeds the artifact parser budget')
    if (typeof value === 'string') {
      push(asset(value, hint))
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, hint, depth + 1)
      return
    }
    if (!value || typeof value !== 'object') return
    const row = value as Record<string, unknown>
    const type =
      typeof row.content_type === 'string'
        ? row.content_type
        : typeof row.mime_type === 'string'
          ? row.mime_type
          : undefined
    const mime = type?.split(';', 1)[0]?.trim().toLowerCase()
    if (typeof row.url === 'string') push(asset(row.url, hint, mime))
    const base64 = row.b64_json ?? row.data
    if (
      typeof base64 === 'string' &&
      /^[a-z0-9+/]+={0,2}$/i.test(base64) &&
      base64.length % 4 === 0
    ) {
      const modality = mime ? (modalityOfMime(mime) ?? hint) : hint
      if (modality && modality !== 'text')
        push({ base64, mime: mime ?? 'application/octet-stream', modality })
    }
    for (const key of Object.keys(KEYS))
      if (key !== 'url' && Object.hasOwn(row, key)) visit(row[key], KEYS[key] ?? hint, depth + 1)
  }
  visit(raw, output)
  if (outputSchema) {
    const record = (value: unknown): Record<string, unknown> | undefined =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined
    const resolve = (value: unknown) => {
      let schema = record(value)
      for (let count = 0; schema && typeof schema.$ref === 'string'; count++) {
        if (count >= 16 || !schema.$ref.startsWith('#/'))
          throw new Error('Generated output schema has an unsupported reference')
        let target: unknown = outputSchema
        for (const part of schema.$ref
          .slice(2)
          .split('/')
          .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
          const parent = record(target)
          target = parent && Object.hasOwn(parent, part) ? parent[part] : undefined
        }
        schema = record(target)
      }
      return schema
    }
    function declared(value: unknown, description: unknown, depth = 0) {
      if (++nodes > 8192 || depth > 16)
        throw new Error('Generated media exceeds the artifact parser budget')
      const schema = resolve(description)
      if (!schema) return
      for (const branch of ['allOf', 'oneOf', 'anyOf'])
        if (Array.isArray(schema[branch]))
          for (const item of schema[branch] as unknown[]) declared(value, item, depth + 1)
      if (Array.isArray(value)) {
        for (const item of value) declared(item, schema.items, depth + 1)
        return
      }
      const row = record(value),
        properties = record(schema.properties)
      // A provider-declared File object may live under any model-specific output name.
      if (
        row &&
        properties &&
        record(properties.url) &&
        ['content_type', 'mime_type', 'file_name', 'file_size'].some((key) =>
          Object.hasOwn(properties, key),
        )
      ) {
        const type =
          typeof row.content_type === 'string'
            ? row.content_type
            : typeof row.mime_type === 'string'
              ? row.mime_type
              : undefined
        if (typeof row.url === 'string')
          push(asset(row.url, output, type?.split(';', 1)[0]?.trim().toLowerCase()))
      }
      if (!row) return
      for (const [key, item] of Object.entries(row)) {
        if (/^(?:inputs?|metadata|prompt|request|parameters|options)(?:_|$)/i.test(key)) continue
        if (properties && Object.hasOwn(properties, key)) declared(item, properties[key], depth + 1)
        else if (record(schema.additionalProperties))
          declared(item, schema.additionalProperties, depth + 1)
      }
    }
    declared(raw, outputSchema)
  }
  return found
}
