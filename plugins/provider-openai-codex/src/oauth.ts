import { PI_ORIGINATOR } from '@loncothad/dsh-plugin-runtime'
/**
 * ChatGPT Codex OAuth domain: PKCE material, authorize-URL and token
 * request construction, token-response parsing, and id-token claims.
 * Pure domain: randomness, HTTP, and time are injected.
 *
 * Wire constants follow the public Codex-compatible client.
 *
 * @module @loncothad/dsh-provider-openai-codex/oauth
 */

/** OAuth issuer serving ChatGPT browser OAuth. */
export const OAUTH_ISSUER = 'https://auth.openai.com'

/** OAuth token endpoint. */
export const OAUTH_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token'

/** Public OAuth client identifier used by Codex-compatible clients. */
export const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/** The scopes requested by ChatGPT browser OAuth. */
export const OAUTH_SCOPES: readonly string[] = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'api.connectors.read',
  'api.connectors.invoke',
]

/** Localhost callback ports allowed by the OAuth client. */
export const CALLBACK_PORTS: readonly number[] = [1455, 1457]

/** The Codex Responses endpoint the adapter streams from. */
export const CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'

/** The pi-compatible originator sent with Codex operations and authorization. */
export const CODEX_ORIGINATOR = PI_ORIGINATOR

/** CSRF state bytes. */
const STATE_BYTES = 32

/** PKCE verifier bytes. */
const VERIFIER_BYTES = 64

/** One account's renewable token set, as stored in a grant payload. */
export interface CodexTokens {
  readonly accessToken: string
  readonly idToken?: string
  readonly refreshToken?: string
  /** Epoch milliseconds after which the access token should be refreshed. */
  readonly expiresAt: number
}

/** The grant payload one account persists as. */
export interface CodexAccountPayload {
  readonly kind: 'codex-account-v1'
  readonly name: string
  /** Unverified id-token `chatgpt_account_id` claim, when present. */
  readonly accountId?: string
  /** Unverified id-token `chatgpt_plan_type` claim, when present. */
  readonly planType?: string
  readonly tokens: CodexTokens
}

/** PKCE + CSRF material for one authorization attempt. */
export interface PkceMaterial {
  readonly state: string
  readonly verifier: string
  readonly challenge: string
}

/** URL-safe base64 of one random byte string. */
function b64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** Random bytes through the injected source. */
function randomBytes(count: number, random: () => number): Uint8Array {
  const bytes = new Uint8Array(count)
  for (let i = 0; i < count; i += 1) bytes[i] = Math.floor(random() * 256)
  return bytes
}

/** Fresh PKCE material (S256 challenge). */
export async function makePkce(
  random: () => number,
  sha256: (input: string) => Promise<string>,
): Promise<PkceMaterial> {
  const verifier = b64url(randomBytes(VERIFIER_BYTES, random))
  const digest = await sha256(verifier)
  return { state: b64url(randomBytes(STATE_BYTES, random)), verifier, challenge: digest }
}

/** The localhost callback URI for one port. */
export function callbackUri(port: number): string {
  return `http://localhost:${port}/auth/callback`
}

/** Build the browser authorization URL for one attempt. */
export function authorizeUrl(material: PkceMaterial, port: number, idTokenHint?: string): string {
  const url = new URL('/oauth/authorize', OAUTH_ISSUER)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', OAUTH_CLIENT_ID)
  url.searchParams.set('redirect_uri', callbackUri(port))
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '))
  url.searchParams.set('state', material.state)
  url.searchParams.set('code_challenge', material.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', CODEX_ORIGINATOR)
  if (idTokenHint !== undefined) url.searchParams.set('id_token_hint', idTokenHint)
  return url.toString()
}

/** Body for the authorization-code exchange. */
export function tokenRequestBody(
  material: PkceMaterial,
  code: string,
  port: number,
): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: OAUTH_CLIENT_ID,
    code,
    code_verifier: material.verifier,
    redirect_uri: callbackUri(port),
  })
}

/** Body for a refresh-token rotation. */
export function refreshTokenRequestBody(refreshToken: string): {
  grant_type: string
  client_id: string
  refresh_token: string
} {
  return {
    grant_type: 'refresh_token',
    client_id: OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  }
}

/** One parsed token endpoint response. */
export interface TokenResponse {
  readonly accessToken: string
  readonly idToken?: string
  readonly refreshToken?: string
  /** Seconds until the access token expires. */
  readonly expiresIn?: number
}

/** Parse a token endpoint response payload. */
export function parseTokenResponse(payload: unknown): TokenResponse {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('the OAuth token response was not an object')
  }
  const record = payload as Record<string, unknown>
  const accessToken = record.access_token
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('the OAuth token response omitted access_token')
  }
  const expiresIn = record.expires_in
  return {
    accessToken,
    ...(typeof record.id_token === 'string' ? { idToken: record.id_token } : {}),
    ...(typeof record.refresh_token === 'string' ? { refreshToken: record.refresh_token } : {}),
    ...(typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? { expiresIn } : {}),
  }
}

/** Build one account payload from a token response. */
export function accountPayloadFrom(
  name: string,
  response: TokenResponse,
  previous?: CodexAccountPayload,
  now = Date.now(),
): CodexAccountPayload {
  const retainedIdToken = response.idToken ?? previous?.tokens.idToken
  const claims = retainedIdToken !== undefined ? codexClaims(retainedIdToken) : undefined
  const refreshToken = response.refreshToken ?? previous?.tokens.refreshToken
  const accountId =
    typeof claims?.chatgpt_account_id === 'string' ? claims.chatgpt_account_id : undefined
  const planType =
    typeof claims?.chatgpt_plan_type === 'string' ? claims.chatgpt_plan_type : undefined
  return {
    kind: 'codex-account-v1',
    name,
    ...(accountId !== undefined ? { accountId } : {}),
    ...(planType !== undefined ? { planType } : {}),
    tokens: {
      accessToken: response.accessToken,
      ...(retainedIdToken !== undefined ? { idToken: retainedIdToken } : {}),
      ...(refreshToken !== undefined ? { refreshToken } : {}),
      expiresAt: now + (response.expiresIn ?? 3_600) * 1_000,
    },
  }
}

/** Whether the access token is due for refresh (30s skew). */
export function needsRefresh(payload: CodexAccountPayload, now = Date.now()): boolean {
  return payload.tokens.expiresAt - 30_000 <= now
}

/** Decode one JWT's unverified payload claims. */
export function idTokenClaims(idToken: string): Record<string, unknown> | undefined {
  const parts = idToken.split('.')
  if (parts.length !== 3) return undefined
  try {
    const padded = parts[1]!.replaceAll('-', '+').replaceAll('_', '/')
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    const json = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    )
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** Routing hints come from Codex's namespaced JWT claims; they are not authorization. */
export function codexClaims(token: string): Record<string, unknown> | undefined {
  const value = idTokenClaims(token)?.['https://api.openai.com/auth']
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * The account-name grammar, matching the credentials seam's key-segment
 * rule so names are directly addressable: slugified lowercase
 * `[a-z][a-z0-9-]{0,63}`, derived by lowercasing and replacing every
 * non-[a-z0-9] run with one dash.
 */
export function normalizeAccountName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('a Codex account name must be a non-empty string')
  }
  const slugged = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
  if (slugged.length === 0 || slugged.length > 64 || !/^[a-z][a-z0-9-]*$/.test(slugged)) {
    throw new Error(`invalid Codex account name: ${raw.trim()}`)
  }
  return slugged
}
