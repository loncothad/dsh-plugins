/**
 * Exa search-envelope mapping: REST response walker plus the keyless MCP
 * fallback envelope. Pure domain: no harness imports, no network.
 *
 * @module @loncothad/dsh-web-search/providers/exa
 */

/** One normalized citeable source, in the dsh-web portable shape. */
export interface ExaSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
}

/** Normalized outcome of one Exa search. */
export interface ExaResult {
  readonly sources: readonly ExaSource[]
}

/** One result of Exa's `results[]`. */
export interface ExaHit {
  readonly url?: unknown
  readonly title?: unknown
  readonly publishedDate?: unknown
  readonly highlights?: readonly unknown[]
  readonly text?: unknown
}

/** Exa search response envelope. */
export interface ExaSearchResponse {
  readonly results?: readonly ExaHit[]
  readonly error?: unknown
  readonly message?: unknown
}

/** Map one Exa hit to a normalized source; drops hits with no snippet. */
export function mapExaHit(hit: ExaHit): ExaSource | undefined {
  const highlight = hit.highlights?.find((h) => typeof h === 'string' && h.trim().length > 0)
  const snippet = typeof highlight === 'string' ? highlight : undefined
  if (snippet === undefined) return undefined
  const url = hit.url
  if (typeof url !== 'string' || url.length === 0) return undefined
  return {
    url,
    ...text(hit.title, 'title'),
    snippet,
    ...text(hit.publishedDate, 'publishedAt'),
  }
}

/** Map the REST response envelope to a normalized result. */
export function mapExaResponse(response: ExaSearchResponse): ExaResult {
  const sources = (response.results ?? [])
    .map(mapExaHit)
    .filter((source): source is ExaSource => source !== undefined)
  return { sources }
}

/** Exa error envelope message, when present. */
export function exaErrorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  for (const key of ['error', 'message']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** One content block of an MCP tool result. */
export interface McpContentBlock {
  readonly type?: unknown
  readonly text?: unknown
}

/** MCP JSON-RPC tool-call result envelope. */
export interface McpToolResult {
  readonly result?: {
    readonly content?: readonly McpContentBlock[]
  }
  readonly error?: { readonly message?: unknown } | null
}

/**
 * Map the keyless MCP fallback result: content blocks carry JSON-ish text
 * payloads; walk each for URLs and map whatever sources fall out.
 */
export function mapExaMcpResult(result: McpToolResult): ExaResult {
  const error = result.error?.message
  if (typeof error === 'string' && error.length > 0) {
    throw new Error(error)
  }
  const sources: ExaSource[] = []
  const seen = new Set<string>()
  for (const block of result.result?.content ?? []) {
    if (typeof block.text !== 'string' || block.text.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(block.text)
    } catch {
      continue
    }
    for (const source of collectUrls(parsed, seen)) sources.push(source)
  }
  return { sources }
}

function collectUrls(node: unknown, seen: Set<string>): ExaSource[] {
  const out: ExaSource[] = []
  if (Array.isArray(node)) {
    for (const entry of node) out.push(...collectUrls(entry, seen))
    return out
  }
  if (typeof node !== 'object' || node === null) return out
  const record = node as Record<string, unknown>
  const url = record.url
  if (typeof url === 'string' && url.length > 0 && !seen.has(url)) {
    seen.add(url)
    out.push({
      url,
      ...text(record.title, 'title'),
      ...text(record.snippet ?? record.text, 'snippet'),
    })
  }
  for (const value of Object.values(record)) {
    if (value !== null && typeof value === 'object') out.push(...collectUrls(value, seen))
  }
  return out
}

/** Build the JSON-RPC tool-call body for the keyless MCP fallback. */
export function buildExaMcpBody(query: string, numResults?: number): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'web_search_exa',
      arguments: {
        query,
        ...(numResults !== undefined ? { numResults } : {}),
      },
    },
  }
}

function text(value: unknown, key: string): { [k: string]: string } {
  if (typeof value !== 'string' || value.length === 0) return {}
  return { [key]: value }
}
