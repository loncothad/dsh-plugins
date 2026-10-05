import { createHash } from 'node:crypto'
export type ConfigLayer = 'defaults' | 'environment' | 'user' | 'run'
export interface ResolvedConfiguration<T> {
  value: T
  provenance: Record<string, ConfigLayer>
  fingerprint: string
}
const forbidden = new Set(['__proto__', 'constructor', 'prototype'])
function plain(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [null, Object.prototype].includes(Object.getPrototypeOf(value))
  )
}
export function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('JSON nesting exceeds its limit')
  if (typeof value === 'string' && value.length > 131072)
    throw new Error('JSON string exceeds its limit')
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new Error('JSON array exceeds its limit')
    return `[${value.map((child) => canonical(child, depth + 1)).join(',')}]`
  }
  if (plain(value)) {
    if (Object.keys(value).length > 1024) throw new Error('JSON object exceeds its limit')
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        if (forbidden.has(key)) throw new Error('Reserved configuration key')
        return `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`
      })
      .join(',')}}`
  }
  throw new Error('Configuration must contain finite, plain JSON values')
}
export const fingerprint = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex')
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
/** Whole-field replacements in one explicit chain. Arrays and objects never acquire ambiguous merge semantics. */
export function resolveConfiguration<T extends Record<string, unknown>>(
  layers: Partial<Record<ConfigLayer, Record<string, unknown>>>,
  options: {
    keys: readonly string[]
    runKeys: readonly string[]
    validate: (value: Record<string, unknown>) => T
  },
): ResolvedConfiguration<T> {
  const allowed = new Set(options.keys),
    runAllowed = new Set(options.runKeys),
    value: Record<string, unknown> = Object.create(null),
    provenance: Record<string, ConfigLayer> = Object.create(null)
  for (const layer of ['defaults', 'environment', 'user', 'run'] as const) {
    const input = layers[layer] ?? {}
    canonical(input)
    if (!plain(input)) throw new Error('Each configuration layer must be a plain object')
    for (const [key, entry] of Object.entries(input)) {
      if (!allowed.has(key) || forbidden.has(key))
        throw new Error(`Unknown configuration key: ${key}`)
      if (layer === 'run' && !runAllowed.has(key))
        throw new Error(`Per-run override is not admitted: ${key}`)
      value[key] = structuredClone(entry)
      provenance[key] = layer
    }
  }
  const parsed = options.validate(value)
  return freeze({ value: parsed, provenance, fingerprint: fingerprint(parsed) })
}
