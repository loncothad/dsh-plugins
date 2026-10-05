import { getPiUserAgent } from './request-identity.ts'

/** Bounded official-account metadata request. Redirects and raw failure bodies are never exposed. */
export async function subscriptionJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
  body?: unknown,
): Promise<unknown> {
  const response = await transport(url, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    signal,
    headers: {
      'user-agent': getPiUserAgent(),
      ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Account API returned HTTP ${response.status}`)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty subscription response')
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > 256 * 1024) throw new Error('Subscription response exceeds the size limit')
      chunks.push(result.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    signal.throwIfAborted()
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
export const quotaRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid subscription response')
  return value as Record<string, unknown>
}
