/** Versioned JSON recipes keep original payload text behind scoped evidence references. */
import { createHash } from 'node:crypto'
import type { EvidenceHit } from './types.ts'
export type ReplayValue =
  | { kind: 'literal'; value: null | boolean | number | string }
  | { kind: 'array'; items: ReplayValue[] }
  | { kind: 'object'; entries: [string, ReplayValue][] }
  | {
      kind: 'evidence'
      ids: number[]
      startByte: number
      endByte: number
      encoding: 'text' | 'json'
    }
export interface ReplaySource {
  value: unknown
  ids: number[]
  startByte: number
  endByte: number
  encoding: 'text' | 'json'
}
const MAX_BYTES = 16 * 1024 * 1024
export function requestRecipe(value: unknown, sources: readonly ReplaySource[]): ReplayValue {
  const originals = new Map(sources.map((source) => [JSON.stringify(source.value), source]))
  let nodes = 0,
    inline = 0
  function visit(value: unknown, depth: number): ReplayValue {
    if (++nodes > 32768 || depth > 64)
      throw new Error('Replay recipe exceeds its structural budget')
    const source = originals.get(JSON.stringify(value))
    if (source)
      return {
        kind: 'evidence',
        ids: [...source.ids],
        startByte: source.startByte,
        endByte: source.endByte,
        encoding: source.encoding,
      }
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'string'
    ) {
      if (typeof value === 'string') inline += Buffer.byteLength(value, 'utf8')
      if (inline > 256 * 1024)
        throw new Error('Replay requires original references for large request text')
      return { kind: 'literal', value }
    }
    if (Array.isArray(value))
      return { kind: 'array', items: value.map((item) => visit(item, depth + 1)) }
    if (value && typeof value === 'object')
      return {
        kind: 'object',
        entries: Object.entries(value).map(([key, item]) => [key, visit(item, depth + 1)]),
      }
    throw new Error('Replay accepts JSON values only')
  }
  const recipe = visit(value, 0)
  recipeEvidence(recipe)
  return recipe
}
export function recipeEvidence(recipe: ReplayValue): number[] {
  if (Buffer.byteLength(JSON.stringify(recipe), 'utf8') > 1024 * 1024)
    throw new Error('Replay recipe exceeds its metadata budget')
  const ids = new Set<number>()
  let nodes = 0
  function visit(node: ReplayValue, depth: number) {
    if (++nodes > 32768 || depth > 64) throw new Error('Invalid replay recipe')
    if (node.kind === 'evidence') {
      if (
        !node.ids.length ||
        node.ids.length > 4096 ||
        new Set(node.ids).size !== node.ids.length ||
        node.ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
        !Number.isSafeInteger(node.startByte) ||
        !Number.isSafeInteger(node.endByte) ||
        node.startByte < 0 ||
        node.endByte < node.startByte ||
        node.endByte > MAX_BYTES ||
        !['text', 'json'].includes(node.encoding)
      )
        throw new Error('Invalid replay evidence reference')
      node.ids.forEach((id) => {
        ids.add(id)
      })
    } else if (node.kind === 'array')
      node.items.forEach((item) => {
        visit(item, depth + 1)
      })
    else if (node.kind === 'object') {
      if (new Set(node.entries.map(([key]) => key)).size !== node.entries.length)
        throw new Error('Duplicate replay object key')
      node.entries.forEach(([, item]) => {
        visit(item, depth + 1)
      })
    } else if (
      node.kind !== 'literal' ||
      !(
        node.value === null ||
        typeof node.value === 'boolean' ||
        typeof node.value === 'string' ||
        (typeof node.value === 'number' && Number.isFinite(node.value))
      )
    )
      throw new Error('Invalid replay node')
  }
  visit(recipe, 0)
  return [...ids]
}
export function materializeRecipe(
  recipe: ReplayValue,
  read: (ids: number[]) => EvidenceHit[],
  expectedHash: string,
): unknown {
  recipeEvidence(recipe)
  let bytes = 0
  function visit(node: ReplayValue): unknown {
    if (node.kind === 'literal') return node.value
    if (node.kind === 'array') return node.items.map(visit)
    if (node.kind === 'object')
      return Object.fromEntries(node.entries.map(([key, value]) => [key, visit(value)]))
    const chunks: Buffer[] = []
    let length = 0
    for (let offset = 0; offset < node.ids.length; offset += 8) {
      const ids = node.ids.slice(offset, offset + 8),
        hits = read(ids)
      if (hits.length !== ids.length || hits.some((hit, index) => hit.id !== ids[index]))
        throw new Error('Replay evidence is unavailable')
      for (const hit of hits) {
        const chunk = Buffer.from(hit.quote, 'utf8')
        length += chunk.length
        if (length > MAX_BYTES) throw new Error('Replay source exceeds its byte budget')
        chunks.push(chunk)
      }
    }
    if (node.endByte > length) throw new Error('Replay slice exceeds its source')
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks).subarray(node.startByte, node.endByte),
    )
    bytes += Buffer.byteLength(text)
    if (bytes > MAX_BYTES) throw new Error('Replay exceeds its materialization budget')
    return node.encoding === 'json' ? (JSON.parse(text) as unknown) : text
  }
  const value = visit(recipe)
  const canonical = JSON.stringify(value)
  if (Buffer.byteLength(canonical, 'utf8') > MAX_BYTES)
    throw new Error('Replay exceeds its materialization budget')
  if (createHash('sha256').update(canonical).digest('hex') !== expectedHash)
    throw new Error('Replay request hash mismatch')
  return value
}
