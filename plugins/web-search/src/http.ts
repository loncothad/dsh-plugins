/**
 * Shared HTTP transport and error classification for search providers.
 * One assembly instantiated by every provider module: fetch with the
 * provider's headers, abort-aware failure classification, JSON body
 * decoding.
 *
 * @module @loncothad/dsh-web-search/http
 */

import { WebError } from '@deepseek-ai/dsh-web'

/** Common request options every provider transport shares. */
export interface SearchHttpOptions {
  readonly endpoint: string
  readonly headers: Readonly<Record<string, string>>
  readonly fetch?: typeof fetch
}

/** POST JSON and return the parsed body; aborts surface as WEB_ABORTED. */
export async function postJson(
  transport: typeof fetch,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: unknown,
  signal: AbortSignal | undefined,
  label: string,
): Promise<Response> {
  try {
    return await transport(url, {
      method: 'POST',
      redirect: 'error',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (error: unknown) {
    throw searchFailure(`${label} request failed`, error, signal)
  }
}

/** GET a URL and return the parsed body; aborts surface as WEB_ABORTED. */
export async function getJson(
  transport: typeof fetch,
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<Response> {
  try {
    return await transport(url, {
      method: 'GET',
      redirect: 'error',
      headers: { ...headers, accept: 'application/json' },
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (error: unknown) {
    throw searchFailure(`${label} request failed`, error, signal)
  }
}

/** Decode a JSON response body with the same abort contract. */
export async function readJson(
  response: Response,
  signal: AbortSignal | undefined,
  label: string,
): Promise<unknown> {
  try {
    return (await response.json()) as unknown
  } catch (error: unknown) {
    throw searchFailure(`${label} returned an unprocessable response body`, error, signal)
  }
}

/** One shared failure classifier for aborts versus provider errors. */
export function searchFailure(
  prefix: string,
  error: unknown,
  signal: AbortSignal | undefined,
): WebError {
  if (signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError')) {
    return new WebError(
      `${prefix.replace('request failed', '')}aborted`.replace('  ', ' '),
      'WEB_ABORTED',
      { cause: error },
    )
  }
  return new WebError(`${prefix}: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}
