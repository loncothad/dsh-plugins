import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { CodexAdapter } from '../src/adapter.ts'
import type { CallbackListener, SpeedAccess } from '../src/index.ts'
import {
  ACCOUNT_POOL_KEY,
  accountPayloadFrom,
  accountStoreOf,
  authorizeUrl,
  CALLBACK_PORTS,
  idTokenClaims,
  makePkce,
  needsRefresh,
  normalizeAccountName,
  parseTokenResponse,
  quotaExhausted,
  registerCodex,
  registerCodexModelCommands,
  tokenRequestBody,
} from '../src/index.ts'

/** Fake id-token payload, base64url-encoded into a JWT shape. */
function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  return `.${encode(claims)}.sig`
}

const TOKENS = {
  access_token: 'at-1',
  id_token: idToken({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-1234567890',
      chatgpt_plan_type: 'plus',
    },
  }),
  refresh_token: 'rt-1',
  expires_in: 3_600,
}

describe('oauth domain', () => {
  it('rejects invalid account names', () => {
    expect(normalizeAccountName(' main ')).toBe('main')
    expect(() => normalizeAccountName('')).toThrow()
    expect(normalizeAccountName('.Hidden Stuff')).toBe('hidden-stuff')
    expect(() => normalizeAccountName('   ...   ')).toThrow()
    expect(() => normalizeAccountName('x'.repeat(65))).toThrow()
  })

  it('builds PKCE material and the authorize URL', async () => {
    const material = await makePkce(
      () => 0.25,
      async () => 'a'.repeat(43),
    )
    expect(material.state.length).toBeGreaterThan(10)
    expect(material.verifier.length).toBeGreaterThan(10)
    const url = new URL(authorizeUrl(material, 1455))
    expect(url.origin).toBe('https://auth.openai.com')
    expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toContain('offline_access')
    const body = tokenRequestBody(material, 'the-code', 1455)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code_verifier')).toBe(material.verifier)
  })

  it('parses token responses, claims, and expiry', () => {
    const now = 1_000_000
    const parsed = parseTokenResponse(TOKENS)
    expect(parsed.accessToken).toBe('at-1')
    const payload = accountPayloadFrom('main', parsed, undefined, now)
    expect(payload.accountId).toBe('acct-1234567890')
    expect(payload.planType).toBe('plus')
    expect(needsRefresh(payload, now + 3_600_000)).toBe(true)
    expect(needsRefresh(payload, now + 1_000)).toBe(false)
    expect(idTokenClaims(TOKENS.id_token)).toMatchObject({
      'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
    })
    expect(() => parseTokenResponse({})).toThrow()
  })
})

/** In-memory CredentialProvider mounted as the real service. */
class MemoryCredentials extends CredentialProvider {
  readonly records = new Map<string, CredentialRecord>()

  constructor(ctx: Context) {
    super(ctx)
  }

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
  ): Promise<CredentialRecord | undefined> {
    const current = this.records.get(String(key))
    const next = await mutate(current)
    if (next !== undefined) this.records.set(String(key), next)
    this.notifyRecordUpdated(key)
    return this.records.get(String(key))
  }

  override async deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(String(key))
    this.notifyRecordUpdated(key)
  }
}

void Service

function sse(events: readonly unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const streamEvents = [
  { type: 'response.output_text.delta', delta: 'hello' },
  {
    type: 'response.completed',
    response: { id: 'r1', usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } },
  },
]

function stubAgent(ctx: Context): Agent {
  const session = ctx.sessions.create(SessionId(`codex-${Math.random()}`))
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

async function harness(
  tokenResponses: unknown[],
  responsesCalls: { headers: Headers; body: Record<string, unknown> }[],
  speed?: SpeedAccess,
) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  const memory = new MemoryCredentials(ctx)
  new AuthorizationService(ctx)
  let tokenIndex = 0
  const listeners: CallbackListener[] = []
  registerCodex(ctx, speed !== undefined ? { speed } : {}, {
    random: () => 0.25,
    sha256: async () => 'c'.repeat(43),
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url)
      if (target === 'https://auth.openai.com/oauth/token') {
        const payload = tokenResponses[tokenIndex++] ?? TOKENS
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (target.includes('/models?'))
        return new Response(
          JSON.stringify({
            models: [
              {
                slug: 'gpt-5.6-sol',
                display_name: 'GPT-5.6 Sol',
                visibility: 'list',
                supported_in_api: true,
                context_window: 272000,
                default_reasoning_level: 'medium',
                supported_reasoning_levels: ['minimal', 'low', 'medium', 'high', 'xhigh'].map(
                  (effort) => ({ effort }),
                ),
                service_tiers: ['priority', 'ultrafast'],
              },
              {
                slug: 'gpt-6.1-sol',
                display_name: 'GPT-6.1 Sol',
                visibility: 'list',
                supported_in_api: true,
                context_window: 272000,
              },
            ],
          }),
        )
      expect(JSON.parse(init?.body as string).store).toBe(false)
      responsesCalls.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(init?.body as string),
      })
      return sse(streamEvents)
    }) as typeof fetch,
    openBrowser: async () => {},
    listen: async () => {
      const listener: CallbackListener = {
        port: CALLBACK_PORTS[0]!,
        callback: Promise.resolve({
          code: 'auth-code-1',
          state: (
            await makePkce(
              () => 0.25,
              async () => 'c'.repeat(43),
            )
          ).state,
        }),
        close: () => {},
      }
      listeners.push(listener)
      return listener
    },
  })
  // The model-behavior commands mount through their own group; without a
  // selection service mounted they stay available (undeterminable hides
  // nothing), which is what these registerCodex-level tests rely on.
  if (speed !== undefined) {
    registerCodexModelCommands(ctx, { speed, reconcileMs: 3_600_000 })
  }
  return { ctx, memory }
}

describe('store', () => {
  it('uses one atomic account-pool grant in the plugin scope', () => {
    expect(String(ACCOUNT_POOL_KEY)).toBe('openai-codex/accounts')
  })
  it('commits account and active selection together and preserves prior grants when authorization fails', async () => {
    const ctx = new Context()
    try {
      const memory = new MemoryCredentials(ctx)
      const store = accountStoreOf(memory)
      const main = accountPayloadFrom('main', parseTokenResponse(TOKENS))
      await store.authorize(main, async (record) => {
        await memory.modifyRecord(ACCOUNT_POOL_KEY, async () => record)
      })
      const before = structuredClone(await memory.readRecord(ACCOUNT_POOL_KEY))
      await expect(
        store.authorize(accountPayloadFrom('second', parseTokenResponse(TOKENS)), async () => {
          throw new Error('cancelled')
        }),
      ).rejects.toThrow('cancelled')
      expect(await memory.readRecord(ACCOUNT_POOL_KEY)).toEqual(before)
      expect(await store.list()).toEqual(['main'])
      expect(await store.active()).toBe('main')
      await store.remove('main')
      expect(await memory.readRecord(ACCOUNT_POOL_KEY)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
  it('does not let stale refresh responses overwrite newer credentials or restore a logged-out account', async () => {
    const ctx = new Context()
    try {
      const store = accountStoreOf(new MemoryCredentials(ctx))
      const old = accountPayloadFrom('main', parseTokenResponse(TOKENS))
      await store.write('main', () => old)
      const newer = accountPayloadFrom('main', { accessToken: 'newer-token' })
      await store.write('main', () => newer)
      expect(
        (await store.write('main', () => old, old.tokens.accessToken)).tokens.accessToken,
      ).toBe('newer-token')
      await store.remove('main')
      await expect(store.write('main', () => old, old.tokens.accessToken)).rejects.toThrow(
        'removed',
      )
      expect(await store.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

it('fences account selection changes atomically, including reselection and complete pool recreation', async () => {
  const ctx = new Context()
  try {
    const memory = new MemoryCredentials(ctx),
      store = accountStoreOf(memory)
    const main = accountPayloadFrom('main', parseTokenResponse(TOKENS)),
      backup = { ...main, name: 'backup' }
    await store.write('main', () => main)
    await store.write('backup', () => backup)
    await store.setActive('main')
    const original = await store.selection()
    await store.setActive('backup')
    await store.setActive('main')
    expect(await store.switchActive(original.id, 'backup')).toBeUndefined()
    expect(await store.active()).toBe('main')
    const current = await store.selection()
    const switched = await store.switchActive(current.id, 'backup')
    expect(switched?.account?.name).toBe('backup')
    expect(switched?.id).not.toBe(current.id)
    expect(Reflect.set(switched!.account!.tokens, 'accessToken', 'mutated-return-value')).toBe(true)
    expect((await store.read('backup'))?.tokens.accessToken).toBe(backup.tokens.accessToken)
    await store.remove('main')
    await store.remove('backup')
    await store.write('main', () => main)
    await store.write('backup', () => backup)
    await store.setActive('main')
    expect(await store.switchActive(original.id, 'backup')).toBeUndefined()
    expect(await store.active()).toBe('main')
  } finally {
    await ctx.fiber.dispose()
  }
})

describe('plugin lifecycle', () => {
  it('reports no accounts, completes a login through the flow, and lists it', async () => {
    const { ctx, memory } = await harness([], [])
    const agent = stubAgent(ctx)
    await ctx.agents.register(agent)
    const run = async (raw: string) => {
      const settled = await ctx.commands.execute(agent, `/${raw}`, [], new AbortController().signal)
      if (settled === undefined) throw new Error(`${raw} not registered`)
      return settled.result
    }

    expect(await run('codex-accounts')).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('No Codex accounts'),
    })
    expect(await run('codex-status')).toMatchObject({
      kind: 'success',
      text: 'No Codex account is active; open Plugins → ChatGPT Codex → Subscription login.',
    })

    // Drive the flow the way an interactive surface would.
    const outcome = await ctx.authorization.begin({
      key: ACCOUNT_POOL_KEY as never,
      interaction: {
        notify: () => {},
        prompt: async () => 'team',
      },
    })
    expect(outcome.status).toBe('authorized')
    expect(await run('codex-accounts')).toMatchObject({ kind: 'success', text: '* team' })
    expect(await run('codex-status')).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('Plan: plus'),
    })
    expect(memory.records.size).toBe(1)
    expect(
      (memory.records.get('openai-codex/accounts') as { payload: { active: string } }).payload
        .active,
    ).toBe('team')
    await ctx.fiber.dispose()
  })

  it('switches, removes, and falls back when the active account is removed', async () => {
    const { ctx } = await harness([], [])
    const agent = stubAgent(ctx)
    await ctx.agents.register(agent)
    const run = async (raw: string) => {
      const settled = await ctx.commands.execute(agent, `/${raw}`, [], new AbortController().signal)
      if (settled === undefined) throw new Error(`${raw} not registered`)
      return settled.result
    }
    for (const name of ['one', 'two']) {
      await ctx.authorization.begin({
        key: ACCOUNT_POOL_KEY as never,
        interaction: { notify: () => {}, prompt: async () => name },
      })
    }
    expect(await run('codex-accounts')).toMatchObject({
      kind: 'success',
      text: expect.stringMatching(/\* two\n?\s*one| {2}one\n\* two/),
    })
    expect(await run('codex-use one')).toMatchObject({
      kind: 'success',
      text: 'The active Codex account is now one.',
    })
    expect(await run('codex-use nope')).toMatchObject({ kind: 'error' })
    expect(await run('codex-logout one')).toMatchObject({ kind: 'success' })
    expect(await run('codex-use')).toMatchObject({
      kind: 'success',
      text: 'No Codex account is active.',
    })
    expect(await run('codex-logout one')).toMatchObject({ kind: 'error' })
    await ctx.fiber.dispose()
  })

  it('streams from the Responses endpoint with the active tokens and account header', async () => {
    const calls: { headers: Headers; body: Record<string, unknown> }[] = []
    const { ctx } = await harness([], calls)
    await ctx.authorization.begin({
      key: ACCOUNT_POOL_KEY as never,
      interaction: { notify: () => {}, prompt: async () => 'main' },
    })
    const chunks: unknown[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })) {
      chunks.push(chunk)
      if (chunk.type === 'finish') break
    }
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'hello' })
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer at-1')
    expect(calls[0]?.headers.get('chatgpt-account-id')).toBe('acct-1234567890')
    expect(calls[0]?.body).toMatchObject({
      model: 'gpt-5.6-sol',
      instructions: '',
      input: [{ type: 'message', role: 'user' }],
    })
    await ctx.fiber.dispose()
  })

  it('fails with AUTH before any request when no account is active', async () => {
    const calls: { headers: Headers; body: Record<string, unknown> }[] = []
    const { ctx } = await harness([], calls)
    const codes: string[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })) {
      if (chunk.type === 'finish')
        codes.push(chunk.reason.kind === 'error' ? chunk.reason.failure.code : chunk.reason.kind)
    }
    expect(codes).toEqual(['AUTH'])
    expect(calls).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})

describe('speed layer and reasoning', () => {
  async function login(ctx: Context) {
    await ctx.authorization.begin({
      key: ACCOUNT_POOL_KEY as never,
      interaction: { notify: () => {}, prompt: async () => 'main' },
    })
  }

  async function drive(ctx: Context, model: string, reasoningEffort?: string) {
    for await (const chunk of ctx.llm.stream({
      provider: 'codex',
      model,
      ...(reasoningEffort !== undefined ? { reasoningEffort: reasoningEffort as never } : {}),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })) {
      if (chunk.type === 'finish') break
    }
  }

  it('layers fast and ultrafast tiers onto requests, per model', async () => {
    const calls: { headers: Headers; body: Record<string, unknown> }[] = []
    let speed = 'fast'
    const { ctx } = await harness([], calls, {
      speed: () => speed as 'fast',
      setSpeed: (next) => {
        speed = next
      },
    })
    await login(ctx)
    await drive(ctx, 'gpt-5.6-sol')
    expect(calls[0]!.body.service_tier).toBe('priority')
    speed = 'ultrafast'
    await drive(ctx, 'gpt-5.6-sol')
    expect(calls[1]!.body.service_tier).toBe('ultrafast')
    // The fixture's newest flagship advertises no tiers: the selection drops.
    await drive(ctx, 'gpt-6.1-sol')
    expect(calls[2]!.body.service_tier).toBeUndefined()
    speed = 'standard'
    await drive(ctx, 'gpt-5.6-sol')
    expect(calls[3]!.body.service_tier).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('sends the selected reasoning effort and materializes the default', async () => {
    const calls: { headers: Headers; body: Record<string, unknown> }[] = []
    const { ctx } = await harness([], calls)
    await login(ctx)
    await drive(ctx, 'gpt-5.6-sol', 'high')
    expect(calls[0]!.body.reasoning).toEqual({ effort: 'high' })
    // Without an explicit effort the model's default (medium) rides along.
    await drive(ctx, 'gpt-5.6-sol')
    expect(calls[1]!.body.reasoning).toEqual({ effort: 'medium' })
    await ctx.fiber.dispose()
  })

  it('exposes per-model reasoning efforts for the model catalog', async () => {
    const { ctx } = await harness([], [])
    await login(ctx)
    const info = await ctx.llm.resolveModelInfo('codex', 'gpt-5.6-sol')
    expect(info.name).toBe('GPT-5.6 Sol')
    expect(info.reasoning?.efforts.map((effort) => String(effort.id))).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(String(info.reasoning?.defaultEffort)).toBe('medium')
    await ctx.fiber.dispose()
  })

  it('sets the speed through /codex-speed; daybreak is a provider route, not a command', async () => {
    let speed = 'standard'
    const { ctx } = await harness([], [], {
      speed: () => speed as 'standard',
      setSpeed: (next) => {
        speed = next
      },
    })
    const agent = stubAgent(ctx)
    await ctx.agents.register(agent)
    const run = async (raw: string) => {
      const settled = await ctx.commands.execute(agent, `/${raw}`, [], new AbortController().signal)
      if (settled === undefined) throw new Error(`${raw} not registered`)
      return settled.result
    }
    expect(await run('codex-speed')).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('Codex speed: standard'),
    })
    expect(await run('codex-speed ultrafast')).toMatchObject({
      kind: 'success',
      text: 'Codex speed is now ultrafast.',
    })
    expect(speed).toBe('ultrafast')
    expect(await run('codex-speed standard')).toMatchObject({ kind: 'success' })
    expect(await run('codex-speed warp')).toMatchObject({ kind: 'error' })
    // The daybreak toggle is the codex-daybreak provider group in the
    // model window, not a command anymore.
    const gone = await ctx.commands.execute(agent, '/daybreak', [], new AbortController().signal)
    expect(gone).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('shows model commands only while the default selection is a Codex model', async () => {
    let provider = 'zai'
    const { ctx } = await harness([], [])
    const agent = stubAgent(ctx)
    await ctx.agents.register(agent)
    const mounted = async () => {
      const settled = await ctx.commands.execute(
        agent,
        '/codex-speed',
        [],
        new AbortController().signal,
      )
      return settled !== undefined
    }
    // The account commands are provider surface: always present.
    const accounts = await ctx.commands.execute(
      agent,
      '/codex-accounts',
      [],
      new AbortController().signal,
    )
    expect(accounts).toBeDefined()

    registerCodexModelCommands(ctx, {
      activeProvider: () => provider,
      reconcileMs: 20,
      speed: { speed: () => 'standard', setSpeed: () => {} },
    })
    // A non-Codex default selection keeps the model group unmounted.
    expect(await mounted()).toBe(false)
    provider = 'codex'
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(await mounted()).toBe(true)
    // The Daybreak route keeps the model group mounted too.
    provider = 'codex-daybreak'
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(await mounted()).toBe(true)
    provider = 'openrouter'
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(await mounted()).toBe(false)
    await ctx.fiber.dispose()
  })

  it('registers the Daybreak route: cyber-advertising models only, access program on every request', async () => {
    const calls: { headers: Headers; body: Record<string, unknown> }[] = []
    const cyberCatalog = {
      models: [
        {
          slug: 'gpt-5.6-sol',
          display_name: 'GPT-5.6 Sol',
          supported_in_api: true,
          visibility: 'list',
          available_access_programs: { cyber: ['standard', 'daybreak_blue'] },
        },
        {
          slug: 'gpt-5.6-luna',
          display_name: 'GPT-5.6 Luna',
          supported_in_api: true,
          visibility: 'list',
          available_access_programs: { cyber: ['standard'] },
        },
        {
          slug: 'gpt-5.6-terra',
          display_name: 'GPT-5.6 Terra',
          supported_in_api: true,
          visibility: 'list',
          available_access_programs: { cyber: ['standard', 'daybreak_red', 'future_program'] },
        },
      ],
    }
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    new AuthorizationService(ctx)
    new MemoryCredentials(ctx)
    registerCodex(
      ctx,
      {},
      {
        random: () => 0.25,
        sha256: async () => 'c'.repeat(43),
        fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
          const target = String(url)
          if (target === 'https://auth.openai.com/oauth/token') {
            return new Response(JSON.stringify(TOKENS), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          if (target.includes('/models')) {
            return new Response(JSON.stringify(cyberCatalog), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          calls.push({
            headers: new Headers(init?.headers),
            body: JSON.parse(init?.body as string),
          })
          return sse(streamEvents)
        }) as typeof fetch,
        openBrowser: async () => {},
        listen: async () => ({
          port: 1455,
          callback: Promise.resolve({
            code: 'auth-code-1',
            state: (
              await makePkce(
                () => 0.25,
                async () => 'c'.repeat(43),
              )
            ).state,
          }),
          close: () => {},
        }),
      },
    )
    await ctx.authorization.begin({
      key: ACCOUNT_POOL_KEY as never,
      interaction: { notify: () => {}, prompt: async () => 'main' },
    })

    const providers = ctx.llm.listProviders()
    expect(providers.find((info) => info.id === 'codex')?.name).toBe('ChatGPT Codex (subscription)')
    expect(providers.find((info) => info.id === 'codex-daybreak')?.name).toBe(
      'ChatGPT Codex Daybreak (subscription, daybreak_blue)',
    )

    // The standard route carries everything; the Daybreak route narrows
    // to models advertising a daybreak program (unknown programs ignored).
    const standard = await ctx.llm.listModels('codex')
    expect(standard.map((model) => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'gpt-5.6-terra',
    ])
    const daybreak = await ctx.llm.listModels('codex-daybreak')
    expect(daybreak.map((model) => model.id)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra'])

    // Daybreak requests carry the cyber access program; standard requests do not.
    for await (const chunk of ctx.llm.stream({
      provider: 'codex-daybreak',
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })) {
      if (chunk.type === 'finish') break
    }
    expect(calls[0]!.body.access_programs).toEqual({ cyber: 'daybreak_blue' })
    for await (const chunk of ctx.llm.stream({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })) {
      if (chunk.type === 'finish') break
    }
    expect(calls[1]!.body.access_programs).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('keeps the Daybreak group empty while offline: cyber programs are live-catalog facts', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    new AuthorizationService(ctx)
    new MemoryCredentials(ctx)
    registerCodex(
      ctx,
      {},
      {
        random: () => 0.25,
        sha256: async () => 'c'.repeat(43),
        // Every network path fails: the offline seed carries no cyber
        // programs, so the daybreak route honestly lists nothing.
        fetch: (async () => {
          throw new TypeError('offline')
        }) as typeof fetch,
        openBrowser: async () => {},
        listen: async () => {
          throw new Error('not used')
        },
      },
    )
    const standard = await ctx.llm.listModels('codex')
    expect(standard).toEqual([])
    const daybreak = await ctx.llm.listModels('codex-daybreak')
    expect(daybreak).toEqual([])
    await ctx.fiber.dispose()
  })

  it('classifies quota 429s like the official client', async () => {
    expect(quotaExhausted(JSON.stringify({ error: { error_type: 'usage_limit_reached' } }))).toBe(
      true,
    )
    expect(quotaExhausted(JSON.stringify({ error: { code: 'insufficient_quota' } }))).toBe(true)
    expect(quotaExhausted(JSON.stringify({ error: { code: 'credit_balance_exhausted' } }))).toBe(
      true,
    )
    expect(quotaExhausted(JSON.stringify({ error: { error_type: 'server_busy' } }))).toBe(false)
    expect(quotaExhausted('not json')).toBe(false)
  })

  it('falls back to another stored account when the active one hits its quota', async () => {
    const calls: { headers: Headers; body: Record<string, unknown> }[] = []
    const quota429 = () =>
      new Response(
        JSON.stringify({ error: { error_type: 'usage_limit_reached', plan_type: 'plus' } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      )
    let exchange = 0
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    const memory = new MemoryCredentials(ctx)
    new AuthorizationService(ctx)
    registerCodex(
      ctx,
      { accountFallback: true },
      {
        random: () => 0.25,
        sha256: async () => 'c'.repeat(43),
        fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
          const target = String(url)
          if (target === 'https://auth.openai.com/oauth/token') {
            exchange++
            // First login (main) gets at-1; the second (backup) gets at-2.
            const tokens = exchange === 1 ? TOKENS : { ...TOKENS, access_token: 'at-2' }
            return new Response(JSON.stringify(tokens), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          if (target.includes('/models'))
            return new Response(
              JSON.stringify({
                models: [{ slug: 'gpt-5.6-sol', visibility: 'list', context_window: 272000 }],
              }),
            )
          const auth = new Headers(init?.headers).get('authorization')
          calls.push({
            headers: new Headers(init?.headers),
            body: JSON.parse(init?.body as string),
          })
          // The first account's quota is exhausted; the second succeeds.
          if (auth === 'Bearer at-1') return quota429()
          return sse(streamEvents)
        }) as typeof fetch,
        openBrowser: async () => {},
        listen: async () => ({
          port: 1455,
          callback: Promise.resolve({
            code: 'auth-code-1',
            state: (
              await makePkce(
                () => 0.25,
                async () => 'c'.repeat(43),
              )
            ).state,
          }),
          close: () => {},
        }),
      },
    )
    for (const name of ['main', 'backup']) {
      await ctx.authorization.begin({
        key: ACCOUNT_POOL_KEY as never,
        interaction: { notify: () => {}, prompt: async () => name },
      })
    }
    // The last login left 'backup' active; switch back to 'main' so the
    // quota path starts from the exhausted account.
    const agent = stubAgent(ctx)
    await ctx.agents.register(agent)
    const use = await ctx.commands.execute(
      agent,
      '/codex-use main',
      [],
      new AbortController().signal,
    )
    expect(use?.result).toMatchObject({ kind: 'success' })

    const finishes: string[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })) {
      if (chunk.type === 'finish') {
        finishes.push(chunk.reason.kind === 'error' ? chunk.reason.failure.code : chunk.reason.kind)
      }
    }
    // Quota on main -> switch to backup -> success, no error finish.
    expect(finishes).toEqual(['stop'])
    expect(calls.length).toBe(2)
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer at-1')
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer at-2')
    const active = await memory.readRecord(ACCOUNT_POOL_KEY)
    expect((active as { payload: { active: string } }).payload.active).toBe('backup')
    await ctx.fiber.dispose()
  })

  it('reports quota exhaustion when fallback is excluded or disabled', async () => {
    const excluded = new Context()
    await excluded.plugin(LlmRuntime)
    await excluded.plugin(CommandRuntime)
    await excluded.plugin(AgentRegistry)
    await excluded.plugin(SessionStore)
    new AuthorizationService(excluded)
    new MemoryCredentials(excluded)
    registerCodex(
      excluded,
      { accountFallback: true, accountFallbackExclude: 'backup' },
      {
        random: () => 0.25,
        sha256: async () => 'c'.repeat(43),
        fetch: (async (url: RequestInfo | URL) => {
          const target = String(url)
          if (target === 'https://auth.openai.com/oauth/token') {
            return new Response(JSON.stringify(TOKENS), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          if (target.includes('/models')) {
            return new Response(
              JSON.stringify({
                models: [{ slug: 'gpt-5.6-sol', visibility: 'list', context_window: 272000 }],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }
          return new Response(JSON.stringify({ error: { error_type: 'usage_limit_reached' } }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          })
        }) as typeof fetch,
        openBrowser: async () => {},
        listen: async () => ({
          port: 1455,
          callback: Promise.resolve({
            code: 'auth-code-1',
            state: (
              await makePkce(
                () => 0.25,
                async () => 'c'.repeat(43),
              )
            ).state,
          }),
          close: () => {},
        }),
      },
    )
    for (const name of ['main', 'backup']) {
      await excluded.authorization.begin({
        key: ACCOUNT_POOL_KEY as never,
        interaction: { notify: () => {}, prompt: async () => name },
      })
    }
    const agent = stubAgent(excluded)
    await excluded.agents.register(agent)
    await excluded.commands.execute(agent, '/codex-use main', [], new AbortController().signal)
    const codes: string[] = []
    for await (const chunk of excluded.llm.stream({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })) {
      if (chunk.type === 'finish')
        codes.push(chunk.reason.kind === 'error' ? chunk.reason.failure.code : chunk.reason.kind)
    }
    expect(codes).toEqual(['RATE_LIMIT'])
    await excluded.fiber.dispose()
  })
})

it('serializes simultaneous token rotation across adapters sharing native credentials', async () => {
  const ctx = new Context(),
    memory = new MemoryCredentials(ctx),
    first = accountStoreOf(memory),
    second = accountStoreOf(memory)
  try {
    const payload = accountPayloadFrom(
      'main',
      { accessToken: 'expired', refreshToken: 'refresh-once', expiresIn: 1 },
      undefined,
      0,
    )
    await first.write('main', () => payload)
    await first.setActive('main')
    let exchanges = 0
    const transport = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      exchanges++
      expect(JSON.parse(String(init?.body))).toMatchObject({ refresh_token: 'refresh-once' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      return new Response(
        JSON.stringify({
          access_token: 'rotated',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
        }),
      )
    }) as typeof fetch
    const adapters = [
      new CodexAdapter({ store: first, fetch: transport }),
      new CodexAdapter({ store: second, fetch: transport }),
    ]
    expect(
      (await Promise.all(adapters.map((adapter) => adapter.activeTokens()))).map(
        (tokens) => tokens?.accessToken,
      ),
    ).toEqual(['rotated', 'rotated'])
    expect(exchanges).toBe(1)
    expect((await first.read('main'))?.tokens.refreshToken).toBe('rotated-refresh')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('retains namespaced account routing and ID tokens when refresh omits them', () => {
  const previous = accountPayloadFrom('main', parseTokenResponse(TOKENS))
  const refreshed = accountPayloadFrom(
    'main',
    { accessToken: 'new-access', expiresIn: 3600 },
    previous,
  )
  expect(refreshed.accountId).toBe('acct-1234567890')
  expect(refreshed.planType).toBe('plus')
  expect(refreshed.tokens.idToken).toBe(previous.tokens.idToken)
})
