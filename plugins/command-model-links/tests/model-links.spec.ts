import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  mergeGroup,
  nextModel,
  parseLinkTable,
  serializeLinkTable,
  unlinkModel,
} from '../src/groups.ts'
import { registerModelLinkCommands } from '../src/index.ts'

describe('link table domain', () => {
  it('parses groups and drops degenerate entries', () => {
    expect(parseLinkTable('')).toEqual([])
    expect(parseLinkTable(undefined)).toEqual([])
    expect(parseLinkTable('a=b')).toEqual([['a', 'b']])
    expect(parseLinkTable('a=b=c ; d=e ; solo ; = ; a=a=b')).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e'],
      ['a', 'b'],
    ])
  })

  it('round-trips through serialization', () => {
    const groups = [
      ['a', 'b'],
      ['c', 'd', 'e'],
    ] as const
    expect(parseLinkTable(serializeLinkTable(groups))).toEqual(groups)
  })

  it('merges transitively through shared members', () => {
    expect(mergeGroup([], ['a', 'b'])).toEqual([['a', 'b']])
    expect(mergeGroup([['a', 'b']], ['b', 'c'])).toEqual([['a', 'b', 'c']])
    expect(
      mergeGroup(
        [
          ['a', 'b'],
          ['x', 'y'],
        ],
        ['b', 'c'],
      ),
    ).toEqual([
      ['a', 'b', 'c'],
      ['x', 'y'],
    ])
    expect(mergeGroup([['a', 'b']], ['a', 'b'])).toEqual([['a', 'b']])
  })

  it('unlinks members and dissolves small leftovers', () => {
    expect(unlinkModel([['a', 'b', 'c']], 'b')).toEqual({ groups: [['a', 'c']], removed: true })
    expect(unlinkModel([['a', 'b']], 'a')).toEqual({ groups: [], removed: true })
    expect(unlinkModel([['a', 'b']], 'z')).toEqual({ groups: [['a', 'b']], removed: false })
  })

  it('cycles within groups and wraps around', () => {
    const groups = [
      ['a', 'b', 'c'],
      ['x', 'y'],
    ] as const
    expect(nextModel(groups, 'a')).toBe('b')
    expect(nextModel(groups, 'c')).toBe('a')
    expect(nextModel(groups, 'x')).toBe('y')
    expect(nextModel(groups, 'z')).toBeUndefined()
  })
})

/** Build a live idle agent over a store-owned session, as an app's spine does. */
function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
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

let agentCounter = 0

/**
 * Mount the real CommandRuntime, AgentRegistry, SessionStore, and
 * AgentDefaultModelConfig services, then register the link commands with an
 * injected link-table accessor (the same surface `apply` wires to the
 * materialized volatile setting).
 */
async function harness(linksValue: string, modelValue = 'glm-5.3') {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  // A Service subclass self-registers on construction.
  const service = new AgentDefaultModel(ctx, {
    provider: { get: () => 'p' },
    model: { get: () => modelValue },
    reasoningEffort: { get: () => undefined },
  } as never)
  const saved: { provider: string; model: string }[] = []
  ctx.provide('sessionController', {
    selectModel: async (request: { provider: string; model: string }) => {
      saved.push({ provider: request.provider, model: request.model })
      return { selected: request }
    },
  } as unknown as import('@deepseek-ai/dsh-api-session-controller').SessionController)
  const originalSave = service.saveSelection.bind(service)
  service.saveSelection = async (next) => {
    saved.push(next)
    return originalSave(next)
  }
  registerModelLinkCommands(ctx, {
    get: () => linksValue,
    set: (next: string) => {
      linksValue = next
    },
  })
  const agent = stubAgent(ctx, `model-links-${agentCounter++}`)
  await ctx.agents.register(agent)
  return {
    ctx,
    agent,
    saved: () => saved[saved.length - 1],
    links: () => linksValue,
    async run(name: string, rawInput = '') {
      const settled = await ctx.commands.execute(
        agent,
        `/${name}${rawInput}`,
        [],
        new AbortController().signal,
      )
      if (settled === undefined) throw new Error(`command ${name} not registered`)
      return settled.result
    },
  }
}

describe('commands', () => {
  it('shows, creates, and unlinks groups through the command surface', async () => {
    const h = await harness('')
    expect(await h.run('model-links')).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('No model links'),
    })
    expect(
      await h.run(
        'model-link',
        ' p/glm-5.3 = deepseek/deepseek-chat = openrouter/moonshot/kimi-k3 ',
      ),
    ).toMatchObject({
      kind: 'success',
    })
    expect(h.links()).toBe('p/glm-5.3=deepseek/deepseek-chat=openrouter/moonshot/kimi-k3')
    expect(await h.run('model-links')).toMatchObject({
      kind: 'success',
      text: expect.stringContaining(
        'p/glm-5.3  =  deepseek/deepseek-chat  =  openrouter/moonshot/kimi-k3',
      ),
    })
    expect(await h.run('model-unlink', ' deepseek/deepseek-chat')).toMatchObject({
      kind: 'success',
    })
    expect(h.links()).toBe('p/glm-5.3=openrouter/moonshot/kimi-k3')
    expect(await h.run('model-unlink', ' nope')).toMatchObject({ kind: 'error' })
  })

  it('rejects under-specified link arguments', async () => {
    const h = await harness('')
    expect(await h.run('model-link', ' solo')).toMatchObject({ kind: 'error' })
    expect(await h.run('model-unlink', ' ')).toMatchObject({ kind: 'error' })
  })

  it('cycles to the next linked model and reports unlinked models', async () => {
    const h = await harness('p/glm-5.3=openrouter/moonshot/kimi-k3')
    expect(await h.run('model-cycle')).toMatchObject({
      kind: 'success',
      text: 'This conversation now uses openrouter/moonshot/kimi-k3.',
    })
    expect(h.saved()).toEqual({ provider: 'openrouter', model: 'moonshot/kimi-k3' })
    const h2 = await harness('p/a=p/b', 'zzz')
    expect(await h2.run('model-cycle')).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('is not linked'),
    })
  })
})
