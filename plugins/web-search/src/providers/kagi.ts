/**
 * Kagi search-envelope mapping: a generic recursive walker over Kagi's
 * nested response envelopes. Pure domain: no harness imports, no network.
 *
 * @module @loncothad/dsh-web-search/providers/kagi
 */

/** One normalized citeable source, in the dsh-web portable shape. */
export interface KagiSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
}

/** Normalized outcome of one Kagi search. */
export interface KagiResult {
  readonly sources: readonly KagiSource[]
}

/** Keys whose values may contain result arrays or nested envelopes. */
const CONTAINER_KEYS = new Set(['data', 'results', 'items', 'search', 'web', 'news', 'list'])

/**
 * Walk one Kagi envelope recursively, collecting every object that carries
 * a `url`. Kagi nests result arrays under shifting keys depending on the
 * endpoint and bucket, so the walker treats any known container key (and
 * any array of objects) as a branch.
 */
export function collectKagiSources(node: unknown, out: KagiSource[] = []): KagiSource[] {
  if (Array.isArray(node)) {
    for (const entry of node) collectKagiSources(entry, out)
    return out
  }
  if (typeof node !== 'object' || node === null) return out
  const record = node as Record<string, unknown>
  const url = record.url
  if (typeof url === 'string' && url.length > 0) {
    out.push({
      url,
      ...optionalString(record, 'title'),
      ...optionalString(record, 'snippet'),
      ...optionalString(record, 'publishedAt'),
      ...optionalString(record, 'pub_date', 'publishedAt'),
    })
  }
  for (const [key, value] of Object.entries(record)) {
    if (value === null || typeof value !== 'object') continue
    if (CONTAINER_KEYS.has(key) || Array.isArray(value)) {
      collectKagiSources(value, out)
    }
  }
  return out
}

/** Extract a Kagi error envelope's message, when the body is one. */
export function kagiErrorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  const error = record.error
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  if (typeof error === 'string' && error.length > 0) return error
  return undefined
}

/** Map a full search response onto the normalized result. */
export function mapKagiResponse(body: unknown): KagiResult {
  return { sources: collectKagiSources(body) }
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  as: string = key,
): { [k: string]: string } {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) return {}
  return { [as]: value }
}
