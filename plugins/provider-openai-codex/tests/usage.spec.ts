import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  clearFacts,
  describeDelay,
  describeSnapshot,
  recordFact,
  registerCodexUsage,
} from '../src/usage.ts'

const fact = {
  provider: 'codex',
  code: 'RATE_LIMIT',
  status: 429,
  retryAfterMs: 90_000,
  observedAt: 1_000,
}

describe('snapshot domain', () => {
  it('records the latest fact per provider', () => {
    const snapshot = recordFact(recordFact(new Map(), fact), { ...fact, retryAfterMs: 5_000 })
    expect(snapshot.size).toBe(1)
    expect(snapshot.get('codex')?.retryAfterMs).toBe(5_000)
  })

  it('clears selectively and reports what went', () => {
    const snapshot = recordFact(recordFact(new Map(), fact), {
      ...fact,
      provider: 'codex-daybreak',
    })
    expect(clearFacts(snapshot, 'codex')).toMatchObject({ cleared: ['codex'] })
    expect(clearFacts(snapshot).cleared.sort()).toEqual(['codex', 'codex-daybreak'])
    expect(clearFacts(new Map(), 'x')).toMatchObject({ cleared: [] })
  })

  it('renders delays and the snapshot', () => {
    expect(describeDelay(2_500)).toBe('2.5s')
    expect(describeDelay(90_000)).toBe('2min')
    expect(describeDelay(undefined)).toBe('unknown')
    expect(describeSnapshot(recordFact(new Map(), fact))).toBe(
      'codex: RATE_LIMIT (HTTP 429); provider-requested retry after 2min',
    )
    expect(describeSnapshot(new Map())).toBe('No provider usage-limit facts are cached.')
  })
})

function stubAgent(ctx: Context): Agent {
  const session = ctx.sessions.create(SessionId(`usage-${Math.random()}`))
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

/** Fire the request-error emit path the observer listens on. */
function fireEmit(
  ctx: Context,
  payload: {
    provider: string
    failure: { code: string; status?: number; providerRetryAfterMs?: number }
  },
): void {
  const listeners = (
    ctx as unknown as {
      events: { dispatch: (kind: unknown, names: string[]) => Array<(payload: unknown) => unknown> }
    }
  ).events.dispatch('emit', ['agent/request-error'])
  for (const listener of listeners) {
    listener(payload as never)
  }
}

describe('command and observer', () => {
  it('records facts, explains the reset, and clears after reset confirm', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    registerCodexUsage(ctx)
    const agent = stubAgent(ctx)
    await ctx.agents.register(agent)
    const run = async (raw: string) => {
      const settled = await ctx.commands.execute(
        agent,
        `/codex-usage${raw}`,
        [],
        new AbortController().signal,
      )
      if (settled === undefined) throw new Error('usage-reset not registered')
      return settled.result
    }

    expect(await run('')).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('No provider usage-limit facts'),
    })

    fireEmit(ctx, {
      provider: 'codex',
      failure: { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 90_000 },
    })
    fireEmit(ctx, { provider: 'codex', failure: { code: 'AUTH' } })

    expect(await run('')).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('codex: RATE_LIMIT (HTTP 429)'),
    })
    expect(await run(' daybreak reset confirm')).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('Use /codex-usage reset confirm'),
    })
    expect(await run(' reset confirm')).toMatchObject({
      kind: 'success',
      text: 'Cached usage-limit facts cleared for: codex.',
    })
    expect(await run(' reset confirm')).toMatchObject({ kind: 'error' })
  })
})
