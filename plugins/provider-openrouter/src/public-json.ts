/** Shared Host/browser reader for public metadata, bounded before decoding. */
export async function publicJson(
  response: Response,
  signal: AbortSignal,
  maximumBytes = 8 * 1024 * 1024,
): Promise<unknown> {
  signal.throwIfAborted()
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel()
    throw new Error('OpenRouter metadata exceeds its byte limit')
  }
  if (!response.body) throw new Error('OpenRouter metadata has no response body')
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let length = 0
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maximumBytes) throw new Error('OpenRouter metadata exceeds its byte limit')
      chunks.push(next.value)
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  signal.throwIfAborted()
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error('OpenRouter metadata is not valid UTF-8 JSON')
  }
}
