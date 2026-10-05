/**
 * Incremental server-sent-events decoding for streaming wire responses.
 *
 * @module @loncothad/dsh-openai-wire/sse
 */

/**
 * Byte-chunk-in, data-payload-out SSE decoder. Feeds `push()` fragments of
 * the response body as they arrive; each call returns the complete `data:`
 * payloads decoded since the last call. Multi-line data fields join with
 * newlines per the SSE spec; `[DONE]` is passed through for the caller to
 * interpret.
 */
export class SseDecoder {
  private buffer = ''
  private readonly textDecoder = new TextDecoder('utf-8', { fatal: true })

  /**
   * @param chunk - next body fragment (possibly splitting an event or line).
   * @returns complete data payloads ended by this chunk, in order.
   */
  push(chunk: string | Uint8Array): string[] {
    this.buffer +=
      typeof chunk === 'string' ? chunk : this.textDecoder.decode(chunk, { stream: true })
    if (this.buffer.length > 4 * 1024 * 1024) throw new Error('SSE event exceeds 4 MiB')
    const payloads: string[] = []
    // Events are separated by a blank line; tolerate \r\n line endings.
    for (
      let boundary = this.eventBoundary(this.buffer);
      boundary !== undefined;
      boundary = this.eventBoundary(this.buffer)
    ) {
      const rawEvent = this.buffer.slice(0, boundary.index)
      this.buffer = this.buffer.slice(boundary.index + boundary.length)
      const data = dataLinesOf(rawEvent)
      if (data !== undefined) payloads.push(data)
    }
    return payloads
  }

  /** Flush a trailing event left in the buffer at stream end, if complete. */
  flush(): string[] {
    this.buffer += this.textDecoder.decode()
    if (this.buffer.trim().length === 0) {
      this.buffer = ''
      return []
    }
    const data = dataLinesOf(this.buffer)
    this.buffer = ''
    return data === undefined ? [] : [data]
  }

  private eventBoundary(text: string): { index: number; length: number } | undefined {
    const lf = indexOfBlankLine(text, '\n')
    const crlf = indexOfBlankLine(text, '\r\n')
    if (lf === -1 && crlf === -1) return undefined
    if (lf === -1 || (crlf !== -1 && crlf < lf)) {
      return { index: crlf, length: 4 }
    }
    return { index: lf, length: 2 }
  }
}

function indexOfBlankLine(text: string, eol: string): number {
  return text.indexOf(eol + eol)
}

/** Join one raw event's `data:` lines per the SSE field semantics. */
function dataLinesOf(rawEvent: string): string | undefined {
  const lines = rawEvent.split(/\r?\n/)
  const data: string[] = []
  for (const line of lines) {
    if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).replace(/^ /, ''))
    }
    // `event:`, `id:`, `retry:`, and comments are ignored by this decoder.
  }
  if (data.length === 0) return undefined
  return data.join('\n')
}
