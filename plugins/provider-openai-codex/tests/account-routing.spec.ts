import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { CodexAdapter } from '../src/adapter.ts'
import { CODEX_MODELS_TTL_MS } from '../src/discovery.ts'
import type { CodexAccountPayload } from '../src/oauth.ts'
import type { CodexAccountStore } from '../src/store.ts'

function fixture() {
  const accounts = new Map<string, CodexAccountPayload>(
    ['main', 'backup'].map((name) => [
      name,
      {
        kind: 'codex-account-v1',
        name,
        accountId: `account-${name}`,
        tokens: {
          accessToken: `token-${name}`,
          refreshToken: `refresh-${name}`,
          expiresAt: Number.MAX_SAFE_INTEGER,
        },
      },
    ]),
  )
  let active: string | undefined = 'main',
    generation = 0
  const store: CodexAccountStore = {
    async list() {
      return [...accounts.keys()]
    },
    async read(name) {
      return accounts.get(name) && structuredClone(accounts.get(name)!)
    },
    async active() {
      return active
    },
    async activeAccount() {
      return active && accounts.has(active) ? structuredClone(accounts.get(active)!) : undefined
    },
    async write(name, update) {
      const next = await update(accounts.get(name))
      accounts.set(name, next)
      return next
    },
    async remove(name) {
      return accounts.delete(name)
    },
    async selection() {
      return { id: String(generation), account: await this.activeAccount() }
    },
    async switchActive(expected, name) {
      if (expected !== String(generation) || !accounts.has(name)) return undefined
      active = name
      generation++
      return this.selection()
    },
    async setActive(name) {
      active = name
      generation++
    },
  }
  return { store, accounts }
}
const catalog = (id: string, etag?: string) =>
  new Response(
    JSON.stringify({
      models: [{ slug: id, context_window: 32000, service_tiers: [{ id: 'priority' }] }],
    }),
    { headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) } },
  )
const request: GenerateOptions = {
  provider: 'codex',
  model: 'main-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Continue' }] }],
}
async function drain(adapter: CodexAdapter, options = request) {
  for await (const _chunk of adapter.stream(options)) {
    /* Consume the native stream, including terminal outcomes. */
  }
}

it('isolates caches and ETags across accounts, token replacement, and logout', async () => {
  const { store, accounts } = fixture()
  let now = 1000,
    revalidate = false
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const token = new Headers(init?.headers).get('authorization')!
    return revalidate
      ? new Response(null, { status: 304 })
      : catalog(token === 'Bearer token-main' ? 'main-only' : 'backup-only', `"${token}"`)
  })
  const adapter = new CodexAdapter({ store, fetch, now: () => now })
  expect((await adapter.catalog()).models[0]?.id).toBe('main-only')
  await adapter.catalog()
  expect(fetch).toHaveBeenCalledTimes(1)
  await store.setActive('backup')
  expect((await adapter.catalog()).models[0]?.id).toBe('backup-only')
  expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('if-none-match')).toBeNull()
  revalidate = true
  for (let i = 0; i < 2; i++) {
    now += CODEX_MODELS_TTL_MS
    expect((await adapter.catalog()).models[0]?.id).toBe('backup-only')
    expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get('if-none-match')).toBe(
      '"Bearer token-backup"',
    )
  }
  revalidate = false
  accounts.set('backup', {
    ...accounts.get('backup')!,
    tokens: { ...accounts.get('backup')!.tokens, accessToken: 'replacement' },
  })
  await adapter.catalog()
  expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get('if-none-match')).toBeNull()
  const count = fetch.mock.calls.length
  await store.setActive(undefined)
  expect((await adapter.catalog()).models.some((model) => model.id === 'backup-only')).toBe(false)
  expect(fetch).toHaveBeenCalledTimes(count)
  await store.setActive('backup')
  await adapter.catalog()
  expect(fetch).toHaveBeenCalledTimes(count + 1)
})

it('does not let a late response from the old account overwrite the new account cache', async () => {
  const { store } = fixture(),
    gate = Promise.withResolvers<Response>()
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    new Headers(init?.headers).get('authorization') === 'Bearer token-main'
      ? gate.promise
      : catalog('backup-only'),
  )
  const adapter = new CodexAdapter({ store, fetch })
  const old = adapter.catalog()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  await store.setActive('backup')
  expect((await adapter.catalog()).models[0]?.id).toBe('backup-only')
  gate.resolve(catalog('main-only'))
  await old
  expect((await adapter.catalog()).models[0]?.id).toBe('backup-only')
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('propagates model-discovery cancellation rather than returning the offline seed', async () => {
  const { store } = fixture(),
    abort = new AbortController()
  const fetch = vi.fn(
    async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      }),
  )
  const adapter = new CodexAdapter({ store, fetch })
  const result = adapter.catalog(abort.signal)
  const rejected = expect(result).rejects.toThrow('cancelled discovery')
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  abort.abort(new Error('cancelled discovery'))
  await rejected
})

for (const stage of ['quota', 'switch'] as const) {
  it(`does not refresh or retry after cancellation during ${stage}`, async () => {
    const { store, accounts } = fixture(),
      abort = new AbortController()
    accounts.set('backup', {
      ...accounts.get('backup')!,
      tokens: { ...accounts.get('backup')!.tokens, expiresAt: 0 },
    })
    if (stage === 'switch') {
      const set = store.switchActive
      store.switchActive = async (expected, name) => {
        const selected = await set.call(store, expected, name)
        abort.abort(new Error('cancelled fallback'))
        return selected
      }
    }
    const calls: string[] = []
    const fetch = async (url: RequestInfo | URL) => {
      calls.push(String(url))
      if (stage === 'quota') abort.abort(new Error('cancelled fallback'))
      return new Response(JSON.stringify({ error: { code: 'insufficient_quota' } }), {
        status: 429,
      })
    }
    const adapter = new CodexAdapter({
      store,
      fetch,
      accountFallback: { enabled: () => true, exclude: () => [] },
    })
    await expect(drain(adapter, { ...request, signal: abort.signal })).rejects.toThrow(
      'cancelled fallback',
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/responses')
    expect(await store.active()).toBe(stage === 'quota' ? 'main' : 'backup')
  })
}

it('checks service tiers with the same account snapshot used for inference', async () => {
  const { store } = fixture()
  let posts = 0
  const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token-main')
    if (String(url).includes('/models')) {
      await store.setActive('backup')
      return catalog('main-model')
    }
    posts++
    expect(JSON.parse(String(init?.body)).service_tier).toBe('priority')
    return new Response(
      'data: {"type":"response.completed","response":{"output":[]}}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }
  await drain(new CodexAdapter({ store, fetch, serviceTier: () => 'priority' }))
  expect(posts).toBe(1)
})

it('refuses an automatic switch after manual selection changes away and back', async () => {
  const { store } = fixture()
  const list = store.list
  store.list = async () => {
    await store.setActive('backup')
    await store.setActive('main')
    return list()
  }
  let posts = 0
  const adapter = new CodexAdapter({
    store,
    accountFallback: { enabled: () => true, exclude: () => [] },
    fetch: async () => {
      posts++
      return new Response(JSON.stringify({ error: { code: 'insufficient_quota' } }), {
        status: 429,
      })
    },
  })
  const finishes = []
  for await (const chunk of adapter.stream(request))
    if (chunk.type === 'finish') finishes.push(chunk.reason)
  expect(posts).toBe(1)
  expect(await store.active()).toBe('main')
  expect(finishes).toHaveLength(1)
  expect(finishes[0]?.kind).toBe('error')
})

it('refreshes the rejected account and emits one terminal 401 after a failed retry', async () => {
  const { store } = fixture()
  let posts = 0,
    refreshes = 0
  const adapter = new CodexAdapter({
    store,
    fetch: async (url, init) => {
      if (String(url).includes('/oauth/token')) {
        refreshes++
        expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
        expect(JSON.parse(String(init?.body))).toMatchObject({
          grant_type: 'refresh_token',
          refresh_token: 'refresh-main',
        })
        return new Response(JSON.stringify({ access_token: 'rotated-main', expires_in: 3600 }))
      }
      posts++
      await store.setActive('backup')
      return new Response('Unauthorized', { status: 401 })
    },
  })
  const finishes = []
  for await (const chunk of adapter.stream(request))
    if (chunk.type === 'finish') finishes.push(chunk.reason)
  expect(posts).toBe(2)
  expect(refreshes).toBe(1)
  expect(await store.active()).toBe('backup')
  expect(finishes).toEqual([{ kind: 'error', failure: expect.objectContaining({ status: 401 }) }])
})

it('rejects an unsupported output cap before reading credentials or sending inference', async () => {
  const { store } = fixture(),
    transport = vi.fn()
  const adapter = new CodexAdapter({ store, fetch: transport })
  const chunks = []
  for await (const chunk of adapter.stream({ ...request, maxTokens: 32 })) chunks.push(chunk)
  expect(transport).not.toHaveBeenCalled()
  expect(chunks).toMatchObject([
    { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_PARAMETER' } } },
  ])
})
