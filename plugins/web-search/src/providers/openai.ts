/**
 * OpenAI/Codex web-search mapping: the Responses API envelope, covering
 * both the api.openai.com key path and the ChatGPT Codex subscription
 * path. Pure domain: no harness imports, no network.
 *
 * @module @loncothad/dsh-web-search/providers/openai
 */

/** One normalized citeable source. */
export interface OpenAISource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
}

/** Normalized outcome: answer text plus citation sources. */
export interface OpenAIResult {
  readonly content?: string
  readonly sources: readonly OpenAISource[]
}

/** A url_citation annotation on an output-text block. */
export interface UrlCitationAnnotation {
  readonly type?: unknown
  readonly url?: unknown
  readonly title?: unknown
}

/** One content block of an output message. */
export interface OutputContentBlock {
  readonly type?: unknown
  readonly text?: unknown
  readonly annotations?: readonly UrlCitationAnnotation[]
}

/** One item of the Responses `output[]` array. */
export interface OutputItem {
  readonly type?: unknown
  readonly content?: readonly OutputContentBlock[]
}

/** A Responses API envelope (non-streaming, or the completed SSE event). */
export interface ResponsesEnvelope {
  readonly output?: readonly OutputItem[]
  readonly error?: { readonly message?: unknown } | null
}

/** Map a Responses envelope: message text plus url_citation sources. */
export function mapResponsesOutput(envelope: ResponsesEnvelope): OpenAIResult {
  if (envelope.error !== undefined && envelope.error !== null) {
    const message = envelope.error.message
    if (typeof message === 'string' && message.length > 0) {
      throw new Error(message)
    }
  }
  let content: string | undefined
  const sources: OpenAISource[] = []
  const seen = new Set<string>()
  for (const item of envelope.output ?? []) {
    if (item.type !== 'message') continue
    for (const block of item.content ?? []) {
      if (typeof block.text === 'string' && block.text.length > 0 && content === undefined) {
        content = block.text
      }
      for (const annotation of block.annotations ?? []) {
        if (annotation.type !== 'url_citation') continue
        const url = annotation.url
        if (typeof url !== 'string' || url.length === 0 || seen.has(url)) continue
        seen.add(url)
        sources.push({
          url,
          ...text(annotation.title, 'title'),
        })
      }
    }
  }
  return {
    ...(content !== undefined ? { content } : {}),
    sources,
  }
}

function text(value: unknown, key: string): { [k: string]: string } {
  if (typeof value !== 'string' || value.length === 0) return {}
  return { [key]: value }
}
