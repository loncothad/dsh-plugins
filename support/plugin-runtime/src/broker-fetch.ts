import type { Context } from '@deepseek-ai/cordis'
import { HarnessError, INVALID_CREDENTIAL_CODE } from '@deepseek-ai/dsh-llm'
import type {} from '@loncothad/dsh-execution-core'
import { getPiUserAgent } from './request-identity.ts'
/** HTTP consumers receive a borrowed key only at the approved-origin dispatch boundary. */
export function brokerFetch(
  ctx: Context,
  options: {
    consumer: string
    reference: () => string | undefined
    origins: readonly string[]
    scheme: 'Bearer' | 'Key'
    fetch?: typeof fetch
  },
): typeof fetch {
  const origins = new Set(options.origins.map((value) => new URL(value).origin)),
    transport = options.fetch ?? fetch
  return async (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    headers.set('user-agent', getPiUserAgent())
    init = { ...init, headers }
    const reference = options.reference()
    if (!reference) return transport(input, init)
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    if (!headers.has('authorization')) return transport(input, init) // Public catalogs need no credential borrow.
    headers.delete('authorization')
    headers.delete('cookie')
    if (!origins.has(url.origin)) return transport(input, { ...init, headers })
    if (url.protocol !== 'https:')
      throw new HarnessError(
        'Scoped credentials require an approved HTTPS origin',
        INVALID_CREDENTIAL_CODE,
      )
    const broker = ctx.get('secretsBroker')
    if (!broker)
      throw new HarnessError(
        'Secrets Broker is unavailable; stored credentials are not used as a fallback',
        INVALID_CREDENTIAL_CODE,
      )
    try {
      return await broker.withCredentials(
        options.consumer,
        'provider-http',
        [reference],
        init?.signal ?? AbortSignal.timeout(120000),
        async (values, signal) => {
          headers.set('authorization', `${options.scheme} ${values[reference]}`)
          const response = await transport(input, { ...init, headers, redirect: 'error', signal })
          if (response.ok) return response
          await response.body?.cancel()
          // Provider failure bodies can echo credentials. Preserve status, never arbitrary text.
          return new Response(
            JSON.stringify({
              error: {
                message: `Provider request failed (HTTP ${response.status})`,
                code:
                  response.status === 401 || response.status === 403
                    ? 'AUTH'
                    : response.status === 429
                      ? 'RATE_LIMIT'
                      : 'PROVIDER_ERROR',
              },
            }),
            { status: response.status, headers: { 'content-type': 'application/json' } },
          )
        },
      )
    } catch {
      throw new HarnessError(
        'Scoped credential retrieval or provider request failed',
        INVALID_CREDENTIAL_CODE,
      )
    }
  }
}
