/**
 * OpenRouter web-plugin envelope mapping: request projection and response
 * normalization for OpenRouter's hosted `web` search plugin. Pure domain:
 * no harness imports, no network.
 *
 * @module @loncothad/dsh-web-search/providers/openrouter
 */

/** One normalized citeable source, in the dsh-web portable shape. */
export interface OpenRouterSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
}

/** Normalized outcome of one OpenRouter web search. */
export interface OpenRouterResult {
  readonly content?: string
  readonly sources: readonly OpenRouterSource[]
}

/** Request body sent to `/chat/completions`. */
export interface OpenRouterBody {
  readonly model: string
  readonly messages: readonly { role: 'user'; content: string }[]
  readonly plugins: readonly { id: 'web'; max_results?: number }[]
}

/** Build the request body enabling the hosted web plugin. */
export function buildOpenRouterBody(
  query: string,
  options: { model: string; maxResults?: number },
): OpenRouterBody {
  return {
    model: options.model,
    messages: [{ role: 'user', content: query }],
    plugins: [
      {
        id: 'web',
        ...(options.maxResults !== undefined ? { max_results: options.maxResults } : {}),
      },
    ],
  }
}

/** URL-citation annotation as OpenRouter returns it on the message. */
export interface UrlCitation {
  readonly url?: unknown
  readonly title?: unknown
  readonly content?: unknown
}

/** Assistant message shape of a web-plugin answer. */
export interface OpenRouterMessage {
  readonly content?: string | null
  readonly annotations?: readonly { readonly type?: unknown; readonly url_citation?: UrlCitation }[]
}

/** Full non-streaming response envelope. */
export interface OpenRouterResponse {
  readonly choices?: readonly { readonly message?: OpenRouterMessage }[]
  readonly error?: { readonly message?: string } | null
}

/** Map citation annotations to normalized sources, deduplicated in order. */
export function mapCitations(message: OpenRouterMessage | undefined): OpenRouterSource[] {
  const sources: OpenRouterSource[] = []
  const seen = new Set<string>()
  for (const annotation of message?.annotations ?? []) {
    if (annotation.type !== 'url_citation') continue
    const citation = annotation.url_citation
    const url = citation?.url
    if (typeof url !== 'string' || url.length === 0 || seen.has(url)) continue
    seen.add(url)
    sources.push({
      url,
      ...text(citation?.title, 'title'),
      ...text(citation?.content, 'snippet'),
    })
  }
  return sources
}

/** Map a full response: answer text plus citation sources. */
export function mapOpenRouterResponse(response: OpenRouterResponse): OpenRouterResult {
  const message = response.choices?.[0]?.message
  const content = message?.content
  return {
    ...(typeof content === 'string' && content.length > 0 ? { content } : {}),
    sources: mapCitations(message),
  }
}

function text(value: unknown, key: string): { [k: string]: string } {
  if (typeof value !== 'string' || value.length === 0) return {}
  return { [key]: value }
}
