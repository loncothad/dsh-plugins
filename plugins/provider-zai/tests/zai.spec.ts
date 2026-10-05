import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { CredentialProvider, credentialKey } from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { mintZaiApiKey, runZaiOAuthFlow } from '../src/auth.ts'
import * as plugin from '../src/index.ts'

function sse(payloads: readonly string[]): Response {
  const body = `${payloads.map((payload) => `data: ${payload}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const reply = [
  JSON.stringify({
    choices: [{ delta: { content: 'hi' } }],
  }),
  JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  }),
]

const envelope = (data: unknown) => JSON.stringify({ code: 0, data })

describe('zai oauth domain', () => {
  it('runs the CLI flow: init, browser, poll until ready', async () => {
    const seen: { url: string; auth?: string }[] = []
    let polls = 0
    const ready = await runZaiOAuthFlow({
      fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
        const target = String(url)
        const auth = new Headers(init?.headers).get('authorization') ?? undefined
        seen.push({ url: target, auth })
        if (target.endsWith('/oauth/cli/init')) {
          return new Response(
            envelope({
              authorize_url: 'https://zcode.z.ai/authorize/abc',
              flow_id: 'flow-1',
              poll_interval_sec: 1,
              expires_at: (Date.now() + 60_000) / 1000,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        polls++
        return new Response(
          envelope(
            polls === 1
              ? { status: 'pending' }
              : {
                  status: 'ready',
                  token: 'platform-token',
                  zai: { access_token: 'oauth-at', refresh_token: 'rt' },
                  user: { user_id: 'u1', name: 'Ada' },
                },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as typeof fetch,
      sleep: async () => {},
      openBrowser: async (url) => {
        seen.push({ url: `browser:${url}` })
      },
    })
    expect(ready).toEqual({
      accessToken: 'oauth-at',
      refreshToken: 'rt',
      userName: 'Ada',
      zcodeToken: 'platform-token',
    })
    // Both API calls authenticate with the same poll token; the browser
    // opened the authorize URL.
    const init = seen.find((entry) => entry.url.endsWith('/oauth/cli/init'))
    const poll = seen.find((entry) => entry.url.includes('/oauth/cli/poll/'))
    expect(init?.auth).toMatch(/^Bearer [0-9a-f]{64}$/)
    expect(poll?.auth).toBe(init?.auth)
    expect(seen.some((entry) => entry.url === 'browser:https://zcode.z.ai/authorize/abc')).toBe(
      true,
    )
  })

  it('expires before polling when the CLI seconds deadline has passed', async () => {
    let calls = 0
    await expect(
      runZaiOAuthFlow({
        now: () => 100000,
        fetch: (async () => {
          calls++
          return new Response(
            envelope({
              authorize_url: 'https://zcode.z.ai/authorize',
              flow_id: 'f',
              poll_interval_sec: 1,
              expires_at: 99,
            }),
          )
        }) as typeof fetch,
      }),
    ).rejects.toThrow('expired')
    expect(calls).toBe(1)
  })
  it('never treats the platform JWT as the Z.AI provider grant', async () => {
    let calls = 0
    await expect(
      runZaiOAuthFlow({
        fetch: (async () =>
          new Response(
            envelope(
              ++calls === 1
                ? {
                    authorize_url: 'https://zcode.z.ai/authorize',
                    flow_id: 'f',
                    poll_interval_sec: 1,
                    expires_at: Date.now() / 1000 + 60,
                  }
                : { status: 'ready', token: 'platform-only', user: { user_id: 'u' } },
            ),
          )) as typeof fetch,
      }),
    ).rejects.toThrow('access token')
  })
  it('rejects a successful business exchange without the coding-key secret', async () => {
    const rows = [
      { access_token: 'biz' },
      { organizations: [{ organizationId: 'o', projects: [{ projectId: 'p' }] }] },
      [{ name: 'zcode-api-key', apiKey: 'k' }],
      {},
    ]
    await expect(
      mintZaiApiKey('oauth', {
        fetch: (async () => new Response(envelope(rows.shift()))) as typeof fetch,
      }),
    ).rejects.toThrow('secret')
  })
  it('cancels a blocked credential response without persisting a late grant', async () => {
    const cancel = new AbortController()
    const operation = runZaiOAuthFlow({
      signal: cancel.signal,
      fetch: (async () => new Response(new ReadableStream({ start() {} }))) as typeof fetch,
    })
    const rejected = expect(operation).rejects.toThrow('cancelled')
    await Promise.resolve()
    cancel.abort(new Error('cancelled'))
    await rejected
  })
  it('mints the coding key through the biz chain: login, org, list-or-create, copy', async () => {
    const calls: string[] = []
    let keyCreated = false
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url)
      calls.push(`${init?.method ?? 'GET'} ${target.replace('https://api.z.ai', '')}`)
      if (target.endsWith('/api/auth/z/login')) {
        expect(JSON.parse(init?.body as string)).toEqual({ token: 'oauth-at' })
        return new Response(envelope({ access_token: 'biz-tok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (target.endsWith('/api/biz/customer/getCustomerInfo')) {
        return new Response(
          envelope({
            organizations: [
              {
                organizationId: 'org-9',
                projects: [{ projectId: 'proj-1' }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (target.endsWith('/api_keys')) {
        if (init?.method === 'POST') {
          keyCreated = true
          return new Response(envelope({ apiKey: 'key-77' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(
          envelope(keyCreated ? [{ name: 'zcode-api-key', apiKey: 'key-77' }] : []),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (target.includes('/api_keys/copy/')) {
        return new Response(envelope({ secretKey: 'hush' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected ${target}`)
    }) as typeof fetch
    expect(await mintZaiApiKey('oauth-at', { fetch: fetchImpl })).toBe('key-77.hush')
    // Second mint reuses the existing key (list hit, no create).
    expect(await mintZaiApiKey('oauth-at', { fetch: fetchImpl })).toBe('key-77.hush')
  })
})

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
  override async deleteRecord(key: CredentialKey) {
    this.records.delete(String(key))
    this.notifyRecordUpdated(key)
  }
  override async readRecord(key: CredentialKey) {
    return this.records.get(String(key))
  }
  override async describeRecord(key: CredentialKey) {
    return { configured: this.records.has(String(key)), writable: true }
  }
  override async listRecords() {
    return [...this.records.entries()].map(([key, record]) => ({
      key: key as never,
      kind: record.kind,
    }))
  }
  override async modifyRecord(
    key: CredentialKey,
    mutate: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ) {
    const current = this.records.get(String(key))
    const next = await mutate(current)
    if (next !== undefined) this.records.set(String(key), next)
    else this.records.delete(String(key))
    this.notifyRecordUpdated(key)
    return this.records.get(String(key))
  }
}

function stubAgent(ctx: Context): Agent {
  const session = ctx.sessions.create(SessionId(`zai-${Math.random()}`))
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    ctx: new Context(),
    get status() {
      return status
    },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {
      status = 'idle'
    },
    runMaintenance: (task) => task(new AbortController().signal),
    whenIdle() {
      return Promise.resolve()
    },
  }
  return agent
}

describe('zai login wiring', () => {
  it('stores the minted key through the browser flow and serves requests with it', async () => {
    const bodies: Record<string, unknown>[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string))
      return sse(reply)
    }) as typeof fetch
    try {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(CommandRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SessionStore)
      const memory = new MemoryCredentials(ctx)
      new AuthorizationService(ctx)
      plugin.apply(
        ctx,
        { apiKey: 'config-key', codingCnApiKey: 'k2' },
        {
          fetch: (async (url: RequestInfo | URL) => {
            const target = String(url)
            if (target.endsWith('/oauth/cli/init'))
              return new Response(
                envelope({
                  authorize_url: 'https://zcode.z.ai/authorize',
                  flow_id: 'f',
                  poll_interval_sec: 1,
                  expires_at: Date.now() / 1000 + 60,
                }),
              )
            if (target.includes('/oauth/cli/poll/')) {
              return new Response(
                envelope({
                  status: 'ready',
                  token: 'platform',
                  zai: { access_token: 'oauth-at' },
                  user: { user_id: 'u1', name: 'Ada' },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
              )
            }
            if (target.endsWith('/api/auth/z/login')) {
              return new Response(envelope({ access_token: 'biz' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
            }
            if (target.endsWith('/getCustomerInfo')) {
              return new Response(
                envelope({
                  organizations: [{ organizationId: 'o', projects: [{ projectId: 'p' }] }],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
              )
            }
            if (target.endsWith('/api_keys') && !target.includes('/copy/')) {
              return new Response(envelope([{ name: 'zcode-api-key', apiKey: 'k1' }]), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
            }
            if (target.includes('/copy/')) {
              return new Response(envelope({ secretKey: 's1' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
            }
            throw new Error(`unexpected ${target}`)
          }) as typeof fetch,
          sleep: async () => {},
          openBrowser: async () => {},
        },
      )

      // The stored subscription wins over the config key.
      await ctx.authorization.begin({
        key: credentialKey('zai', 'subscription') as never,
        interaction: {
          notify: () => {},
          prompt: async () => 'ada',
        },
      })
      for await (const chunk of ctx.llm.stream({
        provider: 'zai',
        model: 'GLM-5.3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      })) {
        if (chunk.type === 'finish') break
      }
      expect(bodies[0]).toMatchObject({ model: 'GLM-5.3' })
      const stored = memory.records.get('zai/subscription') as
        | { payload: { accounts: { apiKey: string; source: string }[] } }
        | undefined
      expect(stored?.payload.accounts[0]?.apiKey).toBe('k1.s1')
      expect(stored?.payload.accounts[0]?.source).toBe('oauth')

      const agent = stubAgent(ctx)
      await ctx.agents.register(agent)
      const status = await ctx.commands.execute(
        agent,
        '/zai-status',
        [],
        new AbortController().signal,
      )
      expect(status?.result).toMatchObject({
        kind: 'success',
        text: expect.stringContaining('OAuth'),
      })
      await ctx.fiber.dispose()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('accepts a pasted API key and removes it on logout', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    const memory = new MemoryCredentials(ctx)
    new AuthorizationService(ctx)
    plugin.apply(
      ctx,
      {},
      {
        fetch: (async () => {
          throw new Error('network not expected')
        }) as typeof fetch,
        sleep: async () => {},
        openBrowser: async () => {},
      },
    )
    await ctx.authorization.begin({
      key: credentialKey('zai', 'subscription') as never,
      method: 'key',
      interaction: {
        notify: () => {},
        prompt: async (prompt) => (prompt.kind === 'text' ? 'pasted' : 'pasted.key'),
      },
    })
    expect(
      (memory.records.get('zai/subscription') as { payload: { accounts: { apiKey: string }[] } })
        .payload.accounts[0]?.apiKey,
    ).toBe('pasted.key')

    const agent = stubAgent(ctx)
    await ctx.agents.register(agent)
    const removed = await ctx.commands.execute(
      agent,
      '/zai-logout',
      [],
      new AbortController().signal,
    )
    expect(removed?.result).toMatchObject({ kind: 'success' })
    expect(memory.records.get('zai/subscription')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('registers both routes as subscriptions with their catalogs', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    new MemoryCredentials(ctx)
    new AuthorizationService(ctx)
    plugin.apply(
      ctx,
      { apiKey: 'k1', codingCnApiKey: 'k2' },
      {
        fetch: (async () => {
          throw new Error('offline')
        }) as typeof fetch,
      },
    )
    const providers = ctx.llm.listProviders()
    expect(providers.find((info) => info.id === 'zai')?.name).toBe('Z.AI GLM (subscription)')
    const models = await ctx.llm.listModels('zai')
    expect(models.map((model) => model.id)).toContain('GLM-5.3')
    const resolved = await ctx.llm.resolveModelInfo('zai', 'GLM-5.3')
    expect(resolved.reasoning?.efforts.map((effort) => String(effort.id))).toEqual([
      'low',
      'high',
      'max',
    ])
    await ctx.fiber.dispose()
  })
})
