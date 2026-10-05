import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import {
  delayFor,
  isRetryable,
  parseChain,
  registerFallbackRouter,
  resolvePolicy,
  STOCK_POLICY,
  type TunableRetryPolicy,
  withinBudget,
} from '../src/index.ts'

const noJitter = (): number => 0.5

describe('policy domain', () => {
  it('resolves and clamps policies', () => {
    expect(resolvePolicy({})).toEqual({ ...STOCK_POLICY })
    expect(resolvePolicy({ maxRetries: -5, jitterRatio: 9, maxDelayMs: 0 })).toMatchObject({
      maxRetries: 0,
      jitterRatio: 1,
      maxDelayMs: 1,
    })
  })

  it('classifies retryability by code', () => {
    expect(isRetryable(STOCK_POLICY, { code: 'RATE_LIMIT' })).toBe(true)
    expect(isRetryable(STOCK_POLICY, { code: 'AUTH' })).toBe(false)
  })

  it('schedules exponential backoff with symmetric jitter, capped', () => {
    const policy = { ...STOCK_POLICY, initialDelayMs: 1_000, jitterRatio: 0 }
    expect(delayFor(policy, 1, { code: 'RATE_LIMIT' }, noJitter)).toBe(1_000)
    expect(delayFor(policy, 2, { code: 'RATE_LIMIT' }, noJitter)).toBe(2_000)
    expect(delayFor(policy, 3, { code: 'RATE_LIMIT' }, noJitter)).toBe(4_000)
    expect(delayFor(policy, 30, { code: 'RATE_LIMIT' }, noJitter)).toBe(10_000)
  })

  it('honors provider-requested delays that fit the ceiling', () => {
    expect(
      delayFor(STOCK_POLICY, 1, { code: 'RATE_LIMIT', providerRetryAfterMs: 2_500 }, noJitter),
    ).toBe(2_500)
  })

  it('enforces the attempt budget', () => {
    expect(withinBudget({ ...STOCK_POLICY, maxRetries: 2 }, 1)).toBe(true)
    expect(withinBudget({ ...STOCK_POLICY, maxRetries: 2 }, 2)).toBe(false)
  })
})

/** Adapter scripted with errors and one final successful text stream. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  private consumed = 0

  constructor(private readonly errors: readonly LlmError[]) {
    super()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const error = this.errors[this.consumed++]
    if (error !== undefined) throw error
    const text = 'done'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Mount the agent spine, the tunable policy, and a scripted adapter. */
async function harness(
  policy: TunableRetryPolicy,
  enabled: boolean,
  errors: readonly LlmError[],
): Promise<{ ctx: Context; adapter: ScriptedAdapter; delays: number[] }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const delays: number[] = []
  registerFallbackRouter(
    ctx,
    {
      policy: () => policy,
      enabled: () => enabled,
      chains: () => [],
      fallbackCodes: () => ['RATE_LIMIT', 'SERVER', 'AUTH'],
    },
    {
      random: noJitter,
      sleep: async (ms) => {
        delays.push(ms)
      },
    },
  )
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter(errors)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter, delays }
}

async function drive(ctx: Context, text: string): Promise<void> {
  const agent = await ctx.agentLoop.create(SessionId(`tunable-${Math.random()}`), {
    provider: 'mock',
    model: 'mock',
  })
  agent.followup(
    createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }),
  )
  await agent.whenIdle()
}

describe('recovery listener in composition', () => {
  it('retries in-policy failures with backoff until success', async () => {
    const { ctx, adapter, delays } = await harness(
      { ...STOCK_POLICY, maxRetries: 3, initialDelayMs: 10, maxDelayMs: 50, jitterRatio: 0 },
      true,
      [
        new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
        new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
      ],
    )
    await drive(ctx, 'go')
    expect(adapter.requests).toHaveLength(3)
    expect(delays).toEqual([10, 20])
    await ctx.fiber.dispose()
  })

  it('stops deferring once the budget is exhausted', async () => {
    const { ctx, adapter, delays } = await harness(
      { ...STOCK_POLICY, maxRetries: 1, initialDelayMs: 10, jitterRatio: 0 },
      true,
      [new LlmError('busy', 'RATE_LIMIT'), new LlmError('busy', 'RATE_LIMIT')],
    )
    await drive(ctx, 'go')
    // Two attempts total: the initial call plus one budgeted retry.
    expect(adapter.requests).toHaveLength(2)
    expect(delays).toEqual([10])
    await ctx.fiber.dispose()
  })

  it('leaves non-retryable and disabled cases to downstream policy', async () => {
    const auth = await harness({ ...STOCK_POLICY, maxRetries: 3 }, true, [
      new LlmError('no key', 'AUTH'),
    ])
    await drive(auth.ctx, 'go')
    expect(auth.adapter.requests).toHaveLength(1)
    expect(auth.delays).toEqual([])
    await auth.ctx.fiber.dispose()

    const off = await harness({ ...STOCK_POLICY, maxRetries: 3 }, false, [
      new LlmError('busy', 'RATE_LIMIT'),
    ])
    await drive(off.ctx, 'go')
    expect(off.adapter.requests).toHaveLength(1)
    expect(off.delays).toEqual([])
    await off.ctx.fiber.dispose()
  })
})

describe('fallback chains', () => {
  it('parses chains with slashed models, wildcards, and efforts', () => {
    const chain = parseChain('codex/* > openrouter/openai/gpt-6.1-sol=low > zai/glm-5.3')
    expect(chain.primary).toEqual({ provider: 'codex', model: '*' })
    expect(chain.fallbacks).toEqual([
      { provider: 'openrouter', model: 'openai/gpt-6.1-sol', reasoningEffort: 'low' },
      { provider: 'zai', model: 'glm-5.3' },
    ])
    expect(() => parseChain('only/one')).toThrow('at least one fallback')
    expect(() => parseChain('noprovider > a/b')).toThrow('provider/model')
  })

  /** Adapter whose failures are scripted per model. */
  class PerModelAdapter extends LlmAdapter {
    readonly requests: GenerateOptions[] = []
    private readonly consumed = new Map<string, number>()
    constructor(private readonly errors: ReadonlyMap<string, readonly LlmError[]>) {
      super()
    }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(options)
      const index = this.consumed.get(options.model) ?? 0
      this.consumed.set(options.model, index + 1)
      const error = this.errors.get(options.model)?.[index]
      if (error !== undefined) throw error
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  /** Two scripted adapters: a dead primary and a healthy fallback route. */
  async function chainHarness(chainSpec: string, errors: readonly LlmError[]) {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const delays: number[] = []
    registerFallbackRouter(
      ctx,
      {
        policy: () => ({ ...STOCK_POLICY, maxRetries: 3, initialDelayMs: 10, jitterRatio: 0 }),
        enabled: () => true,
        chains: () => [parseChain(chainSpec)],
        fallbackCodes: () => ['RATE_LIMIT', 'SERVER', 'AUTH'],
      },
      {
        random: noJitter,
        sleep: async (ms) => {
          delays.push(ms)
        },
      },
    )
    await ctx.plugin(AgentLoop, { agents: [] })
    const dead = new ScriptedAdapter(errors)
    const alive = new ScriptedAdapter([])
    ctx.llm.registerAdapter(['mock'], dead)
    ctx.llm.registerAdapter(['backup'], alive)
    return { ctx, dead, alive, delays }
  }

  async function driveOn(ctx: Context, provider: string, model: string): Promise<void> {
    const agent = await ctx.agentLoop.create(SessionId(`chain-${Math.random()}`), {
      provider,
      model,
    })
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'go' }],
        source: { kind: 'user' },
      }),
    )
    await agent.whenIdle()
  }

  it('routes an unavailable model to the next chain route without backoff', async () => {
    const { ctx, dead, alive, delays } = await chainHarness('mock/primary > backup/spare', [
      new LlmError('busy', 'RATE_LIMIT'),
    ])
    await driveOn(ctx, 'mock', 'primary')
    expect(dead.requests.map((request) => request.model)).toEqual(['primary'])
    expect(alive.requests.map((request) => request.model)).toEqual(['spare'])
    // Fallback is immediate: no backoff sleep on the dead route.
    expect(delays).toEqual([])
    await ctx.fiber.dispose()
  })

  it('walks the chain on repeated failures and exhausts gracefully', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    registerFallbackRouter(
      ctx,
      {
        policy: () => ({ ...STOCK_POLICY, maxRetries: 3, initialDelayMs: 10, jitterRatio: 0 }),
        enabled: () => true,
        chains: () => [parseChain('mock/* > backup/one > backup/two')],
        fallbackCodes: () => ['RATE_LIMIT', 'SERVER', 'AUTH'],
      },
      { random: noJitter, sleep: async () => {} },
    )
    await ctx.plugin(AgentLoop, { agents: [] })
    const dead = new ScriptedAdapter([new LlmError('busy', 'SERVER')])
    // backup/one fails once; backup/two succeeds.
    const flaky = new PerModelAdapter(new Map([['one', [new LlmError('busy', 'RATE_LIMIT')]]]))
    ctx.llm.registerAdapter(['mock'], dead)
    ctx.llm.registerAdapter(['backup'], flaky)
    await driveOn(ctx, 'mock', 'primary')
    expect(dead.requests.map((request) => request.model)).toEqual(['primary'])
    expect(flaky.requests.map((request) => request.model)).toEqual(['one', 'two'])
    await ctx.fiber.dispose()
  })

  it('falls back on AUTH and leaves unrelated providers alone', async () => {
    const missed = await chainHarness('other/* > backup/spare', [
      new LlmError('busy', 'RATE_LIMIT'),
    ])
    await driveOn(missed.ctx, 'mock', 'primary')
    expect(missed.alive.requests).toHaveLength(0)
    await missed.ctx.fiber.dispose()

    const authed = await chainHarness('mock/* > backup/spare', [new LlmError('no key', 'AUTH')])
    await driveOn(authed.ctx, 'mock', 'primary')
    expect(authed.alive.requests.map((request) => request.model)).toEqual(['spare'])
    await authed.ctx.fiber.dispose()
  })
})
