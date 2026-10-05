/** Codex device authorization for remote and headless Harness hosts. */
import { setTimeout as delay } from 'node:timers/promises'
import { getPiUserAgent } from '@loncothad/dsh-plugin-runtime'
import type { TokenResponse } from './oauth.ts'
import { OAUTH_CLIENT_ID, OAUTH_ISSUER, OAUTH_TOKEN_ENDPOINT, parseTokenResponse } from './oauth.ts'

function object(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('Invalid device authorization response')
  return payload as Record<string, unknown>
}

function required(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`Device authorization omitted ${field}`)
  return value
}

/** Request a user code, poll until approved, and exchange the issued code using its PKCE verifier. */
export async function deviceLogin(options: {
  signal: AbortSignal
  notify: (notice: { message: string; url: string; code: string }) => void
  fetch?: typeof fetch
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}): Promise<TokenResponse> {
  const transport = options.fetch ?? fetch
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(15 * 60_000)])
  const post = (path: string, body: object) =>
    transport(`${OAUTH_ISSUER}/api/accounts/deviceauth/${path}`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { 'user-agent': getPiUserAgent(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const started = await post('usercode', { client_id: OAUTH_CLIENT_ID })
  if (!started.ok)
    throw new Error(
      `Device authorization unavailable (HTTP ${started.status}); check device login permissions or use browser login`,
    )
  const device = object(await started.json())
  const deviceId = required(device, 'device_auth_id')
  const code = required(device, device.user_code === undefined ? 'usercode' : 'user_code')
  const interval = Number(device.interval ?? 5)
  if (!Number.isFinite(interval) || interval < 0 || interval > 60)
    throw new Error('Invalid device authorization polling interval')
  const url = `${OAUTH_ISSUER}/codex/device`
  options.notify({ message: `Sign in at ${url} and enter ${code}`, url, code })
  for (;;) {
    signal.throwIfAborted()
    const polled = await post('token', { device_auth_id: deviceId, user_code: code })
    if (polled.status === 403 || polled.status === 404) {
      await (options.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort })))(
        Math.max(1, interval) * 1000,
        signal,
      )
      continue
    }
    if (!polled.ok) throw new Error(`Device authorization failed (HTTP ${polled.status})`)
    const approved = object(await polled.json())
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OAUTH_CLIENT_ID,
      code: required(approved, 'authorization_code'),
      code_verifier: required(approved, 'code_verifier'),
      redirect_uri: `${OAUTH_ISSUER}/deviceauth/callback`,
    })
    const exchanged = await transport(OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'user-agent': getPiUserAgent(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })
    if (!exchanged.ok) throw new Error(`Device token exchange failed (HTTP ${exchanged.status})`)
    return parseTokenResponse(await exchanged.json())
  }
}
