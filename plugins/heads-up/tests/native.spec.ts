import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Commands from '@deepseek-ai/dsh-commands'
import {
  createUserMessage,
  type GenerateOptions,
  LlmAdapter,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { readPrivateState } from '@loncothad/dsh-plugin-runtime'
import { expect, it, vi } from 'vitest'
import { apply as recoveryApply } from '../../execution-recovery/src/index.ts'
import type { State } from '../src/domain.ts'
import { apply, ownerRoot } from '../src/index.ts'

it('aggregates owned subagent notices privately and shares only after an explicit human discussion action', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-heads-up-native-')),
    ctx = new Context()
  try {
    await mkdir(join(dir, 'workspace'))
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Commands)
    await ctx.plugin(AgentLoop, { agents: [] })
    class Model extends LlmAdapter {
      async resolveModel(provider: string, id: string) {
        return { provider, id, name: id, context: { contextWindow: 128000 } }
      }
      async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'text',
            text: String(request.sessionId).includes('child')
              ? 'Tests were not run.'
              : 'The main task is in progress.',
          },
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['fixture'], new Model())
    await apply(ctx, { stateDirectory: dir, debounceMs: 100 })
    const root = await ctx.agentLoop.create(
      SessionId('heads-up-root'),
      { provider: 'fixture', model: 'main' },
      { cwd: join(dir, 'workspace') },
    )
    const child = await ctx.agents.create({
      sessionId: SessionId('heads-up-child'),
      parentAgent: root,
      agentOptions: { provider: 'fixture', model: 'main' },
      meta: { cwd: join(dir, 'workspace'), parentSession: root.id },
    })
    expect(ownerRoot(ctx, child.agent).id).toBe(root.id)
    child.agent.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Review fixture.' }],
      }),
    )
    await child.agent.whenIdle()
    await child.dispose()
    const state = () => readPrivateState<State>(ctx, root.id, 'headsUp')
    await vi.waitFor(async () => expect((await state()).notices).toHaveLength(1))
    const notice = (await state()).notices[0]!
    expect(notice.sources[0]?.sessionId).toBe(child.agent.id)
    expect(JSON.stringify(root.session.snapshotEvents())).not.toContain(notice.title)
    const command = (text: string) =>
      ctx.commands.execute(root, text, [], new AbortController().signal)
    expect((await command(`/heads-up acknowledge ${notice.id}`))?.result.kind).toBe('success')
    expect((await state()).notices[0]?.state).toBe('acknowledged')
    expect((await command(`/heads-up discuss ${notice.id}`))?.result.kind).toBe('success')
    expect((await command(`/heads-up discuss ${notice.id}`))?.result.text).toContain(
      'already shared',
    )
    expect((await command(`/heads-up dismiss ${notice.id}`))?.result.text).toContain(
      'already shared',
    )
    expect((await state()).notices[0]?.state).toBe('discussed')
    await root.whenIdle()
    expect(
      root.session
        .snapshotEvents()
        .some((e) => e.type === 'user/message' && e.data.source.kind === 'heads-up-discussion'),
    ).toBe(true)
    expect(
      root.session
        .snapshotEvents()
        .filter((e) => e.type === 'user/message' && e.data.source.kind === 'heads-up-discussion'),
    ).toHaveLength(1)
    expect((await command('/heads-up pause'))?.result.kind).toBe('success')
    expect((await state()).paused).toBe(true)
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

it('withdraws an in-flight reviewer, retains reservations and replays notices after re-enable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-heads-up-cancel-')),
    ctx = new Context(),
    started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  try {
    await mkdir(join(dir, 'workspace'))
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Commands)
    await ctx.plugin(AgentLoop, { agents: [] })
    await recoveryApply(
      ctx,
      { dataDir: join(dir, 'execution'), leaseMs: 3000 },
      {
        workerUrl: new URL(
          '../../../support/execution-core/lib/journal-worker.js',
          import.meta.url,
        ),
      },
    )
    class Model extends LlmAdapter {
      async resolveModel(provider: string, id: string) {
        return { provider, id, name: id, context: { contextWindow: 128000 } }
      }
      async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        if (request.model === 'reviewer') {
          started.resolve()
          await release.promise
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'text',
            text: request.model === 'reviewer' ? '{"findings":[]}' : 'Tests were not run.',
          },
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['fixture'], new Model())
    const owner = ctx.plugin(
      { inject: ['agents', 'sessions', 'commands', 'llm'], apply },
      {
        automatic: false,
        modelEnabled: true,
        reviewerProvider: 'fixture',
        reviewerModel: 'reviewer',
        stateDirectory: dir,
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 1,
      },
    )
    await owner.await()
    const root = await ctx.agentLoop.create(
      SessionId('heads-up-cancel'),
      { provider: 'fixture', model: 'main' },
      { cwd: join(dir, 'workspace') },
    )
    root.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Work fixture.' }],
      }),
    )
    await root.whenIdle()
    const operation = ctx.commands.execute(
      root,
      '/heads-up review',
      [],
      new AbortController().signal,
    )
    await started.promise
    await owner.dispose()
    expect((await operation)?.result.text).toContain('cancelled')
    release.resolve()
    const next = ctx.plugin(
      { inject: ['agents', 'sessions', 'commands', 'llm'], apply },
      { automatic: false, stateDirectory: dir },
    )
    await next.await()
    const restored = await readPrivateState<State>(ctx, root.id, 'headsUp')
    expect(restored.calls).toBe(1)
    expect(restored.reservedUsd).toBeGreaterThan(0)
    expect(restored.notices).toEqual([])
    expect(restored.streams[root.id]).toBeUndefined()
    expect(
      (await ctx.commands.execute(root, '/heads-up review', [], new AbortController().signal))
        ?.result.kind,
    ).toBe('success')
    expect((await readPrivateState<State>(ctx, root.id, 'headsUp')).notices[0]?.title).toBe(
      'Verification is still missing',
    )
    expect(
      (await ctx.commands.execute(root, '/runs dead', [], new AbortController().signal))?.result
        .text,
    ).toContain('heads-up-review')
  } finally {
    release.resolve()
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

it('cancels a child review when its owning chat closes after root ownership bookkeeping is withdrawn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-heads-up-owner-close-')),
    ctx = new Context(),
    started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  try {
    await mkdir(join(dir, 'workspace'))
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Commands)
    await ctx.plugin(AgentLoop, { agents: [] })
    await recoveryApply(
      ctx,
      { dataDir: join(dir, 'execution'), leaseMs: 3000 },
      {
        workerUrl: new URL(
          '../../../support/execution-core/lib/journal-worker.js',
          import.meta.url,
        ),
      },
    )
    class Model extends LlmAdapter {
      async resolveModel(provider: string, id: string) {
        return { provider, id, name: id, context: { contextWindow: 128000 } }
      }
      async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        if (request.model === 'reviewer') {
          started.resolve()
          await release.promise
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'text',
            text: request.model === 'reviewer' ? '{"findings":[]}' : 'Tests were not run.',
          },
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['fixture'], new Model())
    await apply(ctx, {
      automatic: false,
      modelEnabled: true,
      reviewerProvider: 'fixture',
      reviewerModel: 'reviewer',
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      stateDirectory: dir,
    })
    const root = await ctx.agents.create({
      sessionId: SessionId('heads-up-closed-root'),
      agentOptions: { provider: 'fixture', model: 'main' },
      meta: { cwd: join(dir, 'workspace') },
    })
    const child = await ctx.agents.create({
      sessionId: SessionId('heads-up-live-child'),
      parentAgent: root.agent,
      agentOptions: { provider: 'fixture', model: 'main' },
      meta: { cwd: join(dir, 'workspace'), parentSession: root.agent.id },
    })
    child.agent.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Child work fixture.' }],
      }),
    )
    await child.agent.whenIdle()
    const operation = ctx.commands.execute(
      child.agent,
      '/heads-up review',
      [],
      new AbortController().signal,
    )
    await started.promise
    await root.dispose()
    expect((await operation)?.result.text).toContain('cancelled')
    expect(ctx.sessions.get(root.agent.id)).toBeUndefined()
    release.resolve()
  } finally {
    release.resolve()
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

it('reports observation capacity without preventing an unobserved subagent from being created', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-heads-up-capacity-')),
    ctx = new Context()
  try {
    await mkdir(join(dir, 'workspace'))
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Commands)
    await ctx.plugin(AgentLoop, { agents: [] })
    await apply(ctx, { automatic: false, maxLiveSources: 1, stateDirectory: dir })
    const root = await ctx.agents.create({
      sessionId: SessionId('heads-up-cap-root'),
      agentOptions: { provider: 'fixture', model: 'main' },
      meta: { cwd: join(dir, 'workspace') },
    })
    const child = await ctx.agents.create({
      sessionId: SessionId('heads-up-cap-child'),
      parentAgent: root.agent,
      agentOptions: { provider: 'fixture', model: 'main' },
      meta: { cwd: join(dir, 'workspace'), parentSession: root.agent.id },
    })
    expect(ctx.agents.get(child.agent.id)).toBe(child.agent)
    await vi.waitFor(async () =>
      expect((await readPrivateState<State>(ctx, root.agent.id, 'headsUp')).error).toContain(
        'Some agents are not observed',
      ),
    )
    await root.dispose()
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
