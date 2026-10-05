import { Context, Service } from '@deepseek-ai/cordis'
import { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type {
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
} from '@deepseek-ai/dsh-credentials'
import { CredentialProvider, credentialKey } from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from '../src/adapter.ts'
import {
  CODEX_MODELS_TTL_MS,
  cacheFresh,
  modelsUrl,
  parseModelsResponse,
  serviceTierForRequest,
} from '../src/discovery.ts'
import * as plugin from '../src/index.ts'
import type { CodexAccountStore } from '../src/store.ts'

const backendCatalog = {
  models: [
    {
      slug: 'gpt-5.7-atlas',
      display_name: 'GPT-5.7 Atlas',
      description: 'newest flagship',
      supported_in_api: true,
      visibility: 'list',
      priority: 30,
      context_window: 300_000,
      max_context_window: 400_000,
      default_reasoning_level: 'high',
      supported_reasoning_levels: [
        { effort: 'minimal', description: 'lightest thinking' },
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'xhigh' },
        { effort: 'max' },
      ],
      service_tiers: [
        { id: 'priority', name: 'Fast', description: 'Fast processing' },
        { id: 'ultrafast', name: 'Ultrafast', description: 'Ultrafast processing' },
      ],
    },
    {
      slug: 'gpt-5.7-internal',
      display_name: 'Internal',
      supported_in_api: true,
      visibility: 'hidden',
      context_window: 300_000,
    },
    {
      slug: 'gpt-legacy-api',
      display_name: 'ChatGPT Only',
      supported_in_api: false,
      visibility: 'list',
      priority: 40,
    },
    {
      slug: 'gpt-5.7-ghost',
      display_name: 'Ghost',
      supported_in_api: true,
      visibility: 'none',
    },
    {
      slug: 'gpt-5.7-mini',
      display_name: 'GPT-5.7 Mini',
      supported_in_api: true,
      context_window: 200_000,
      priority: 10,
    },
    {
      slug: 'gpt-5.7-turbo',
      display_name: 'GPT-5.7 Turbo',
      supported_in_api: true,
      priority: 20,
    },
  ],
}

const parsed = parseModelsResponse(backendCatalog)

function modelsResponse(body: unknown, etag?: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(etag !== undefined ? { etag } : {}),
    },
  })
}

describe('discovery domain', () => {
  it('builds the official request URL', () => {
    expect(modelsUrl()).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.160.0')
    expect(modelsUrl('https://gw.test/backend-api/codex/models/')).toBe(
      'https://gw.test/backend-api/codex/models?client_version=0.160.0',
    )
  })

  it('maps slugs, names, windows, reasoning, and service tiers', () => {
    expect(parsed.models.map((model) => model.id)).toEqual([
      'gpt-5.7-mini',
      'gpt-5.7-turbo',
      'gpt-5.7-atlas',
      'gpt-legacy-api',
    ])
    const atlas = parsed.models.find((model) => model.id === 'gpt-5.7-atlas')!
    expect(atlas.name).toBe('GPT-5.7 Atlas')
    expect(atlas.description).toBe('newest flagship')
    expect(atlas.contextWindow).toBe(300_000)
    expect(atlas.serviceTiers).toEqual(['priority', 'ultrafast'])
    expect(atlas.reasoning).toMatchObject({
      defaultEffort: 'high',
      efforts: [
        { id: 'minimal', name: 'Minimal', description: 'lightest thinking' },
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
        { id: 'xhigh', name: 'Extra High' },
        { id: 'max', name: 'Max' },
      ],
    })
    const mini = parsed.models.find((model) => model.id === 'gpt-5.7-mini')!
    expect(mini.name).toBe('GPT-5.7 Mini')
    expect(mini.contextWindow).toBe(200_000)
    expect(mini.reasoning).toBeUndefined()
    expect(mini.serviceTiers).toBeUndefined()
  })

  it('orders by the backend priority, lowest first, stable within ties', () => {
    // The raw array lists mini before turbo; priority 10 precedes 20.
    expect(parsed.models.map((model) => model.id)).toEqual([
      'gpt-5.7-mini',
      'gpt-5.7-turbo',
      'gpt-5.7-atlas',
      'gpt-legacy-api',
    ])
  })

  it('drops hidden/unlisted models while preserving ChatGPT-only subscription models', () => {
    const ids = parsed.models.map((model) => model.id)
    expect(ids).not.toContain('gpt-5.7-internal')
    expect(ids).not.toContain('gpt-5.7-ghost')
    expect(ids).toContain('gpt-legacy-api')
  })

  it('filters service tiers per model like the official client', () => {
    const atlas = parsed.models.find((model) => model.id === 'gpt-5.7-atlas')!
    expect(serviceTierForRequest(atlas, 'priority')).toBe('priority')
    expect(serviceTierForRequest(atlas, 'ultrafast')).toBe('ultrafast')
    // flex is always an API request option, even unadvertised.
    expect(serviceTierForRequest(atlas, 'flex')).toBe('flex')
    // Unadvertised tiers and the default sentinel drop to undefined.
    expect(serviceTierForRequest(atlas, 'warp')).toBeUndefined()
    expect(serviceTierForRequest(atlas, 'default')).toBeUndefined()
    expect(serviceTierForRequest(atlas, undefined)).toBeUndefined()
    expect(serviceTierForRequest(undefined, 'priority')).toBeUndefined()
  })

  it('rejects catalogs with duplicate or empty slugs (official rule)', () => {
    expect(() => parseModelsResponse({ models: [{ slug: 'a' }, { slug: 'a' }] })).toThrow(
      'unique, non-empty',
    )
    expect(() => parseModelsResponse({ models: [{ slug: '  ' }] })).toThrow('unique, non-empty')
    expect(() => parseModelsResponse({})).toThrow('models array')
    expect(() => parseModelsResponse(null)).toThrow()
  })

  it('keeps undisclosed context capacity unknown', () => {
    const catalog = parseModelsResponse({ models: [{ slug: 'bare', max_context_window: 1000000 }] })
    expect(catalog.models[0]!.contextWindow).toBeUndefined()
  })

  it('treats a cache as fresh only inside the TTL window', () => {
    const cache = { models: [], fetchedAt: 1_000 }
    expect(cacheFresh(cache, 1_000 + CODEX_MODELS_TTL_MS - 1)).toBe(true)
    expect(cacheFresh(cache, 1_000 + CODEX_MODELS_TTL_MS)).toBe(false)
    expect(cacheFresh(undefined, 0)).toBe(false)
  })
})

function adapterWith(
  fetchImpl: typeof fetch,
  now?: () => number,
  storeOverride?: CodexAccountStore,
) {
  // A store whose active account carries a fresh token.
  const account = {
    kind: 'codex-account-v1' as const,
    name: 'team',
    accountId: 'acct-1',
    tokens: {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
  }
  const defaultStore: CodexAccountStore = {
    async active() {
      return 'team'
    },
    async activeAccount() {
      return account
    },
    async read() {
      return account
    },
    async write(_name, update) {
      return update(account)
    },
    async remove() {
      return true
    },
    async list() {
      return ['team']
    },
    async selection() {
      return { id: 'fixture', account: await this.activeAccount() }
    },
    async switchActive() {
      return undefined
    },
    async setActive() {
      return undefined
    },
  }
  const store = storeOverride ?? defaultStore
  return new CodexAdapter({ store, fetch: fetchImpl, ...(now !== undefined ? { now } : {}) })
}

describe('adapter discovery', () => {
  it('serves the live catalog from the official endpoint with account headers', async () => {
    const fetch = vi.fn(async () => modelsResponse(backendCatalog, '"v1"'))
    const adapter = adapterWith(fetch as unknown as typeof fetch)
    const models = await adapter.listModels('codex')
    expect(models.map((model) => model.id)).toEqual([
      'gpt-5.7-mini',
      'gpt-5.7-turbo',
      'gpt-5.7-atlas',
      'gpt-legacy-api',
    ])
    expect(models.find((model) => model.id === 'gpt-5.7-atlas')).toMatchObject({
      name: 'GPT-5.7 Atlas',
      description: 'newest flagship',
    })
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0]).toBe(modelsUrl())
    expect(call[1].headers).toMatchObject({
      authorization: 'Bearer at',
      'chatgpt-account-id': 'acct-1',
      originator: 'pi',
      'user-agent': expect.stringMatching(/^pi \(.*; .*\)$/),
    })
  })

  it('caches within the TTL: one fetch serves repeated listModels calls', async () => {
    let clock = 1_000_000
    const fetch = vi.fn(async () => modelsResponse(backendCatalog))
    const adapter = adapterWith(fetch as unknown as typeof fetch, () => clock)
    await adapter.listModels('codex')
    clock += 1_000
    await adapter.listModels('codex')
    await adapter.resolveModel('codex', 'gpt-5.7-atlas')
    expect(fetch).toHaveBeenCalledTimes(1)
    // After the TTL lapses, the next call fetches again.
    clock += 300_000
    await adapter.listModels('codex')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('sends if-none-match on revalidation and honors 304', async () => {
    let clock = 1_000_000
    let status = 200
    const fetch = vi.fn(async () =>
      status === 200
        ? modelsResponse(backendCatalog, '"etag-1"')
        : new Response(null, { status: 304 }),
    )
    const adapter = adapterWith(fetch as unknown as typeof fetch, () => clock)
    await adapter.listModels('codex')
    clock += 300_000
    status = 304
    const models = await adapter.listModels('codex')
    expect(models.map((model) => model.id)).toEqual([
      'gpt-5.7-mini',
      'gpt-5.7-turbo',
      'gpt-5.7-atlas',
      'gpt-legacy-api',
    ])
    const second = fetch.mock.calls[1] as unknown as [string, RequestInit]
    expect((second[1].headers as Record<string, string>)['if-none-match']).toBe('"etag-1"')
  })

  it('advertises no invented models on an initial HTTP or network failure', async () => {
    for (const fetch of [
      async () => new Response('no', { status: 401 }),
      async () => {
        throw new TypeError('offline')
      },
    ])
      await expect(
        adapterWith(fetch as typeof globalThis.fetch).listModels('codex'),
      ).rejects.toThrow('catalog')
  })

  it('falls back when no account is signed in', async () => {
    const fetch = vi.fn()
    const emptyStore: CodexAccountStore = {
      async active() {
        return undefined
      },
      async activeAccount() {
        return undefined
      },
      async read() {
        return undefined
      },
      async write(_name, _update) {
        throw new Error('unused')
      },
      async remove() {
        return false
      },
      async list() {
        return []
      },
      async selection() {
        return { id: 'fixture', account: await this.activeAccount() }
      },
      async switchActive() {
        return undefined
      },
      async setActive() {
        return undefined
      },
    }
    const adapter = adapterWith(fetch as unknown as typeof fetch, undefined, emptyStore)
    const models = await adapter.listModels('codex')
    expect(models).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('resolveModel serves discovered windows, names, and reasoning for new models', async () => {
    const fetch = vi.fn(async () => modelsResponse(backendCatalog))
    const adapter = adapterWith(fetch as unknown as typeof fetch)
    const resolved = await adapter.resolveModel('codex', 'gpt-5.7-atlas')
    expect(resolved.context).toEqual({ contextWindow: 300_000 })
    expect(resolved.name).toBe('GPT-5.7 Atlas')
    expect(resolved.reasoning?.efforts.map((effort) => String(effort.id))).toContain('xhigh')
    expect(String(resolved.reasoning?.defaultEffort)).toBe('high')
    // Unknown ids still resolve (advisory catalog) without a window.
    const unknown = await adapter.resolveModel('codex', 'gpt-future')
    expect(unknown.id).toBe('gpt-future')
  })

  it('derives the models endpoint from a configured gateway endpoint', async () => {
    const account = {
      kind: 'codex-account-v1' as const,
      name: 'team',
      tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: Number.MAX_SAFE_INTEGER },
    }
    const fetch = vi.fn(async () => modelsResponse(backendCatalog))
    const store: CodexAccountStore = {
      async active() {
        return 'team'
      },
      async activeAccount() {
        return account
      },
      async read() {
        return account
      },
      async write(_name, update) {
        return update(account)
      },
      async remove() {
        return true
      },
      async list() {
        return ['team']
      },
      async selection() {
        return { id: 'fixture', account: await this.activeAccount() }
      },
      async switchActive() {
        return undefined
      },
      async setActive() {
        return undefined
      },
    }
    const adapter = new CodexAdapter({
      store,
      endpoint: 'https://gw.test/backend-api/codex/responses',
      fetch: fetch as unknown as typeof fetch,
    })
    await adapter.listModels('codex')
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0].startsWith('https://gw.test/backend-api/codex/models?')).toBe(true)
  })
})

/** In-memory CredentialProvider satisfying the plugin's injects. */
class MemoryCredentials extends CredentialProvider {
  readonly records = new Map<string, CredentialRecord>()

  override async resolve() {
    return undefined
  }
  override async describe() {
    return { configured: false, writable: true }
  }
  override async set() {}
  override async unset() {}
  override async readRecord(key: CredentialKey) {
    return this.records.get(String(key))
  }
  override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    return { configured: this.records.has(String(key)), writable: true }
  }
  override async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return [...this.records.entries()].map(([key, record]) => ({
      key: key as never,
      kind: record.kind,
    }))
  }
  override async modifyRecord(
    key: CredentialKey,
    mutate: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(String(key)))
    if (next !== undefined) this.records.set(String(key), next)
    return this.records.get(String(key))
  }
  override async deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(String(key))
  }
}

describe('plugin wiring', () => {
  it('registers model discovery under the openai-codex namespace', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    new AuthorizationService(ctx)
    new MemoryCredentials(ctx)
    const handle = await ctx.plugin(plugin, {})
    // The draft names the adapter's route; the registered discovery
    // answers from the same live path (empty while signed out).
    const models = await ctx.llm.discoverModels('openai-codex', { provider: 'codex' })
    expect(models).toEqual([])
    await handle.dispose()
    void Service
    void credentialKey
  })
})
