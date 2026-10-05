import { setTimeout as delay } from 'node:timers/promises'
/**
 * Z.AI subscription login, grounded in the reference clients:
 *
 * - **CLI OAuth** (zai-org/ZCode): a random poll token posts to
 *   `zcode.z.ai/api/v1/oauth/cli/init` (`{provider: 'zai'}`), the user
 *   authorizes at the returned `authorize_url`, and
 *   `oauth/cli/poll/<flow_id>` (same poll token) resolves to
 *   `{status: 'ready', token, zai: {access_token, refresh_token?}, user}`.
 * - **API-key mint** (ZCode's coding-plan resolver): the OAuth access
 *   token exchanges for a biz token at `api.z.ai/api/auth/z/login`;
 *   `getCustomerInfo` picks the default organization/project; an API key
 *   named `zcode-api-key` is listed-or-created and copied, yielding the
 *   coding-plan key `apiKey.secretKey` — the key the coding endpoints
 *   take.
 * - **API-key entry** (earendil-works/pi style): the user pastes an
 *   existing coding-plan key directly.
 *
 * Pure domain: fetch, browser-open, and the clock are injected.
 *
 * @module @loncothad/dsh-provider-zai/auth
 */

/** The ZCode platform origin serving the CLI OAuth flow. */
export const ZAI_OAUTH_BASE_URL = 'https://zcode.z.ai/api/v1'

/** The Z.AI open API origin. */
export const ZAI_API_HOST = 'https://api.z.ai'

/** The API-key name the reference client mints for coding plans. */
export const ZAI_API_KEY_NAME = 'zcode-api-key'

/** One CLI OAuth flow's initialization outcome. */
export interface ZaiOAuthInit {
  readonly authorizeUrl: string
  readonly flowId: string
  readonly pollIntervalSec: number
  readonly expiresAt: number
}

/** The polled flow's terminal state. */
export interface ZaiOAuthReady {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly userName?: string
  readonly zcodeToken?: string
}

/** Deterministic hooks for tests. */
export interface ZaiAuthInternals {
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  openBrowser?: (url: string) => Promise<void>
  signal?: AbortSignal
  notify?: (notice: { message: string; url?: string }) => void
}

async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => {})
    if (signal.aborted) abort()
  })
}

/**
 * Run the CLI OAuth flow: initialize, open the browser at the authorize
 * URL, and poll until ready, expired, or failed.
 */
export async function runZaiOAuthFlow(internals: ZaiAuthInternals = {}): Promise<ZaiOAuthReady> {
  const fetchImpl = internals.fetch ?? fetch
  const now = internals.now ?? Date.now
  const signal = AbortSignal.any([
    internals.signal ?? new AbortController().signal,
    AbortSignal.timeout(5 * 60_000),
  ])
  const sleep =
    internals.sleep ??
    (async (ms) => {
      await delay(ms, undefined, { signal })
    })
  const pollToken = randomHex(32)

  const init = await postJson(fetchImpl, `${ZAI_OAUTH_BASE_URL}/oauth/cli/init`, {
    authorization: `Bearer ${pollToken}`,
    body: { provider: 'zai' },
    signal,
  })
  if (init.code !== 0) throw new Error('Invalid ZCode CLI initialization envelope')
  const initData = expectRecord(init.data)
  const authorizeUrl = stringOf(initData.authorize_url)
  const flowId = stringOf(initData.flow_id)
  if (authorizeUrl === undefined || flowId === undefined) {
    throw new Error('the Z.AI OAuth init response omitted its authorize URL or flow id')
  }
  const pollIntervalSec = initData.poll_interval_sec
  const expirySeconds = initData.expires_at
  if (
    typeof pollIntervalSec !== 'number' ||
    !Number.isFinite(pollIntervalSec) ||
    pollIntervalSec < 1 ||
    pollIntervalSec > 60 ||
    typeof expirySeconds !== 'number' ||
    !Number.isFinite(expirySeconds)
  )
    throw new Error('Invalid Z.AI authorization deadline or polling interval')
  // ZCode CLI's expires_at is an epoch-seconds timestamp.
  const expiresAt = expirySeconds * 1_000
  const authorization = new URL(authorizeUrl)
  if (authorization.protocol !== 'https:') throw new Error('Invalid Z.AI authorization URL')
  if (expiresAt <= now()) throw new Error('The Z.AI authorization has expired')
  internals.notify?.({
    message: 'Authorize your Z.AI subscription in the browser.',
    url: authorizeUrl,
  })
  if (internals.openBrowser) await cancellable(internals.openBrowser(authorizeUrl), signal)
  for (;;) {
    signal.throwIfAborted()
    if (now() >= expiresAt) throw new Error('The Z.AI authorization has expired')
    const poll = await getJson(
      fetchImpl,
      `${ZAI_OAUTH_BASE_URL}/oauth/cli/poll/${encodeURIComponent(flowId)}`,
      {
        authorization: `Bearer ${pollToken}`,
        signal,
      },
    )
    if (poll.code !== 0) throw new Error('Invalid ZCode CLI polling envelope')
    const data = expectRecord(poll.data)
    const status = stringOf(data.status)
    if (status === 'ready') {
      signal.throwIfAborted()
      if (now() >= expiresAt) throw new Error('The Z.AI authorization has expired')
      const provider = expectRecord(data.zai)
      const accessToken = stringOf(provider.access_token) ?? stringOf(provider.accessToken)
      if (
        accessToken === undefined ||
        !stringOf(data.token) ||
        !stringOf(expectRecord(data.user).user_id)
      ) {
        throw new Error('the Z.AI OAuth flow completed without an access token')
      }
      const user = expectRecord(data.user)
      return {
        accessToken,
        zcodeToken: stringOf(data.token),
        ...((stringOf(provider.refresh_token) ?? stringOf(provider.refreshToken)) !== undefined
          ? { refreshToken: (stringOf(provider.refresh_token) ?? stringOf(provider.refreshToken))! }
          : {}),
        ...(user !== undefined && stringOf(user.name) !== undefined
          ? { userName: stringOf(user.name) }
          : {}),
      }
    }
    if (status === 'failed') {
      throw new Error('the Z.AI authorization failed or was denied in the browser')
    }
    if (status !== 'pending') throw new Error('Invalid Z.AI authorization status')
    if (now() >= expiresAt) {
      throw new Error('the Z.AI authorization timed out waiting for the browser')
    }
    await cancellable(sleep(Math.min(pollIntervalSec * 1_000, expiresAt - now())), signal)
  }
}

/**
 * Mint a coding-plan API key from an OAuth access token, exactly like the
 * reference client: biz token → default organization/project →
 * list-or-create `zcode-api-key` → copy the secret → `key.secret`.
 */
export async function mintZaiApiKey(
  accessToken: string,
  internals: ZaiAuthInternals = {},
): Promise<string> {
  const fetchImpl = internals.fetch ?? fetch
  const signal = AbortSignal.any([
    internals.signal ?? new AbortController().signal,
    AbortSignal.timeout(60_000),
  ])
  signal.throwIfAborted()
  if (!accessToken.trim()) throw new Error('A Z.AI provider grant is required')

  // OAuth access token -> biz token.
  const login = await postJson(fetchImpl, `${ZAI_API_HOST}/api/auth/z/login`, {
    body: { token: accessToken },
    signal,
  })
  const bizToken =
    stringOf(expectRecord(login.data).access_token) ??
    stringOf(expectRecord(login.data).accessToken)
  if (bizToken === undefined) {
    throw new Error('the Z.AI biz-token exchange returned no access token')
  }
  const headers = { authorization: `Bearer ${bizToken}`, signal }

  // Default organization and project.
  const customer = await getJson(
    fetchImpl,
    `${ZAI_API_HOST}/api/biz/customer/getCustomerInfo`,
    headers,
  )
  const organizations = Array.isArray(expectRecord(customer.data).organizations)
    ? (expectRecord(customer.data).organizations as unknown[])
    : []
  const firstOrg = expectRecord(
    organizations.find((org) =>
      String(expectRecord(org).organizationName ?? '').includes('默认机构'),
    ) ?? organizations[0],
  )
  const organizationId = stringOf(firstOrg.organizationId) ?? stringOf(firstOrg.organization_id)
  const projects = Array.isArray(firstOrg.projects) ? (firstOrg.projects as unknown[]) : []
  const firstProject = expectRecord(
    projects.find((project) =>
      String(expectRecord(project).projectName ?? '').includes('默认项目'),
    ) ?? projects[0],
  )
  const projectId = stringOf(firstProject.projectId) ?? stringOf(firstProject.project_id)
  if (organizationId === undefined || projectId === undefined) {
    throw new Error('the Z.AI account exposed no organization/project to mint a coding key into')
  }
  const keysUrl = `${ZAI_API_HOST}/api/biz/v1/organization/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/api_keys`

  // List-or-create the coding key, then copy its secret.
  const listed = await getJson(fetchImpl, keysUrl, headers)
  const keys = Array.isArray(listed.data) ? (listed.data as unknown[]) : []
  const existing = keys.map(expectRecord).find((entry) => stringOf(entry.name) === ZAI_API_KEY_NAME)
  let keyEntry = existing
  if (keyEntry === undefined) {
    const created = await postJson(fetchImpl, keysUrl, {
      ...headers,
      body: { name: ZAI_API_KEY_NAME },
    })
    keyEntry = expectRecord(created.data)
  }
  const apiKey = stringOf(keyEntry.apiKey) ?? stringOf(keyEntry.api_key)
  if (apiKey === undefined) {
    throw new Error('the Z.AI API-key creation returned no key')
  }
  const copied = await getJson(fetchImpl, `${keysUrl}/copy/${encodeURIComponent(apiKey)}`, headers)
  const secret =
    stringOf(expectRecord(copied.data).secretKey) ?? stringOf(expectRecord(copied.data).secret_key)
  signal.throwIfAborted()
  if (!secret) throw new Error('The Z.AI API key copy response omitted its secret')
  return `${apiKey}.${secret}`
}

/** Random hex bytes as the poll token (the reference client's scheme). */
function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes)
  crypto.getRandomValues(values)
  return [...values].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** One JSON envelope request: `{code, data, msg}` with code 0 on success. */
async function envelope(
  fetchImpl: typeof fetch,
  url: string,
  init: { method: 'GET' | 'POST'; authorization?: string; body?: unknown; signal: AbortSignal },
): Promise<{ code: unknown; data: unknown; msg?: unknown }> {
  init.signal.throwIfAborted()
  const response = await fetchImpl(url, {
    method: init.method,
    redirect: 'error',
    signal: init.signal,
    headers: {
      accept: 'application/json',
      ...(init.authorization !== undefined ? { authorization: init.authorization } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  if (!response.ok) {
    throw new Error(`the Z.AI request to ${new URL(url).host} failed (HTTP ${response.status})`)
  }
  const payload: unknown = await boundedJson(response, init.signal)
  const record = expectRecord(payload)
  if (![undefined, null, 0, 200, '0', '200'].includes(record.code as never))
    throw new Error(
      `The Z.AI service rejected authorization (code ${String(record.code).slice(0, 16)})`,
    )
  return record as { code: unknown; data: unknown; msg?: unknown }
}

function postJson(
  fetchImpl: typeof fetch,
  url: string,
  init: { authorization?: string; body?: unknown; signal: AbortSignal },
) {
  return envelope(fetchImpl, url, { method: 'POST', ...init })
}

function getJson(
  fetchImpl: typeof fetch,
  url: string,
  init: { authorization?: string; signal: AbortSignal },
) {
  return envelope(fetchImpl, url, { method: 'GET', ...init })
}

function expectRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : ({} as Record<string, unknown>)
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Auth responses are small; never accumulate an unbounded credential response. */
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty Z.AI authorization response')
  const chunks: Uint8Array[] = []
  let length = 0
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      length += value.length
      if (length > 64 * 1024) throw new Error('Z.AI authorization response exceeds 64 KiB')
      chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      throw new Error('Invalid Z.AI authorization JSON')
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
