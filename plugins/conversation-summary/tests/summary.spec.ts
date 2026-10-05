import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import {
  createUserMessage,
  type GenerateOptions,
  LlmAdapter,
  type StreamChunk,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { type SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { bindWorkspace, captureOriginalLog } from '@loncothad/dsh-evidence-harness'
import { collectNativeText, readPrivateState } from '@loncothad/dsh-plugin-runtime'
import { afterEach, expect, it } from 'vitest'
import { apply as recovery } from '../../execution-recovery/src/index.ts'
import type { Policy } from '../src/config.ts'
import { collectWindow, decisionAnswer } from '../src/domain.ts'
import { apply } from '../src/index.ts'

const contexts: Context[] = [],
  dirs: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
class Provider extends LlmAdapter {
  requests: GenerateOptions[] = []
  auxiliary = 'External summary marker: changed configuration; release remains unapproved.'
  failure = false
  async resolveModel(provider: string, id: string) {
    return { provider, id, name: id, context: { contextWindow: 128000 }, defaultMaxTokens: 2048 }
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const text = request.system?.startsWith('Decide')
      ? 'SEND'
      : request.system?.startsWith('Produce')
        ? this.auxiliary
        : 'Recorded work completed; publication remains unapproved.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield {
      type: 'finish',
      reason: this.failure && request.system ? { kind: 'max-tokens' } : { kind: 'stop' },
    }
  }
}
async function fixture(policy: Partial<Policy> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-summary-')),
    privateDir = await mkdtemp(join(tmpdir(), 'dsh-summary-private-'))
  dirs.push(dir, privateDir)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SqliteSessionQueryEngine, { path: join(dir, 'search.sqlite'), openAt: 'never' })
  ctx.on('session/flush', () => {}) // Acknowledge durability in this controlled, in-memory protocol fixture.
  await recovery(
    ctx,
    { dataDir: join(dir, 'recovery') },
    {
      workerUrl: new URL('../../../support/execution-core/lib/journal-worker.js', import.meta.url),
    },
  )
  await ctx.plugin(AgentLoop, { agents: [] })
  const provider = new Provider()
  ctx.llm.registerAdapter(['fixture'], provider)
  await apply(ctx, { ...policy, stateDirectory: join(privateDir, 'state') })
  const agent = await ctx.agentLoop.create(
    SessionId('summary-test'),
    { provider: 'fixture', model: 'main' },
    { cwd: dir },
  )
  const follow = async (text: string) => {
    agent.followup(
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
    )
    await agent.whenIdle()
  }
  const command = (text = '/summary now') =>
    ctx.commands.execute(agent, text, [], new AbortController().signal)
  return { ctx, agent, provider, follow, command, dir }
}
it('delivers incremental external cards without adding their text to requests or compaction evidence', async () => {
  const f = await fixture({
    generation: 'model',
    summaryProvider: 'fixture',
    summaryModel: 'summary',
  })
  await f.follow('Update configuration. Do not publish.')
  expect((await f.command())?.result.text).toContain('Summary delivered')
  const first = await readPrivateState<import('../src/domain.ts').SummaryState>(
    f.ctx,
    f.agent.id,
    'conversationSummary',
  )
  expect(first.latest?.text).toBeUndefined()
  expect(first.latest?.externalRef).toBeTruthy()
  expect(first.cursor).toBeGreaterThan(0)
  expect(
    (
      await f.ctx.executionRecovery.readResult<{ text: string }>(
        f.agent.id,
        first.latest!.externalRef!,
        'conversation-summary',
      )
    ).text,
  ).toContain('External summary marker')
  expect(
    JSON.stringify((await f.ctx.sessionQuery.readSession(f.agent.session.id)).events),
  ).not.toContain('External summary marker')
  expect(JSON.stringify(f.agent.session.deriveMessages())).not.toContain('External summary marker')
  const captures: unknown[] = []
  await captureOriginalLog(
    {
      capture: async (_scope, event) => {
        captures.push(event)
        return { id: 'fixture', reused: false } as never
      },
      seal: async () => {},
    },
    await bindWorkspace(f.dir),
    await f.ctx.sessionQuery.readSession(f.agent.session.id),
  )
  expect(JSON.stringify(captures)).not.toContain('External summary marker')
  expect((await f.command())?.result.text).toContain('No unsummarized')
  await f.follow('Correction: only prepare artifacts.')
  await f.command()
  const second = await readPrivateState<import('../src/domain.ts').SummaryState>(
    f.ctx,
    f.agent.id,
    'conversationSummary',
  )
  expect(second.latest?.fromSeq).toBe(first.cursor + 1)
  const summaryRequest = f.provider.requests.findLast((request) =>
    request.system?.startsWith('Produce'),
  )!
  expect(JSON.stringify(summaryRequest)).toContain('Correction')
  expect(JSON.stringify(summaryRequest)).not.toContain('External summary marker')
  expect(JSON.stringify(f.provider.requests.filter((request) => !request.system))).not.toContain(
    'External summary marker',
  )
  expect(
    (await f.ctx.sessionQuery.readSession(f.agent.session.id)).events.some((event) =>
      String(event.type).startsWith('conversation-summary/'),
    ),
  ).toBe(false)
})
it('does not advance failed coverage and retains durable call reservations', async () => {
  const f = await fixture({
    generation: 'model',
    summaryProvider: 'fixture',
    summaryModel: 'summary',
    maxModelCallsPerSession: 1,
  })
  await f.follow('Investigate the failing check.')
  f.provider.failure = true
  expect((await f.command())?.result.text).toContain('failed')
  expect(
    (
      await readPrivateState<import('../src/domain.ts').SummaryState>(
        f.ctx,
        f.agent.id,
        'conversationSummary',
      )
    ).cursor,
  ).toBe(-1)
  f.provider.failure = false
  await f.command()
  expect(
    (
      await readPrivateState<import('../src/domain.ts').SummaryState>(
        f.ctx,
        f.agent.id,
        'conversationSummary',
      )
    ).calls,
  ).toBe(1)
  expect(
    f.provider.requests.filter((request) => request.system?.startsWith('Produce')),
  ).toHaveLength(1)
})
it('supports any decision model and delivers after the configured turn boundary', async () => {
  const f = await fixture({ automatic: 'turns', everyTurns: 2 })
  await f.follow('First change')
  await f.command('/summary status')
  expect(
    (
      await readPrivateState<import('../src/domain.ts').SummaryState>(
        f.ctx,
        f.agent.id,
        'conversationSummary',
      )
    ).cursor,
  ).toBe(-1)
  await f.follow('Second change')
  await f.command()
  expect(
    (
      await readPrivateState<import('../src/domain.ts').SummaryState>(
        f.ctx,
        f.agent.id,
        'conversationSummary',
      )
    ).latest?.trigger,
  ).toBe('turns')
  expect(f.provider.requests.filter((request) => request.system)).toHaveLength(0)
  const d = await fixture({
    automatic: 'decision',
    decisionProvider: 'fixture',
    decisionModel: 'any-text-model',
  })
  await d.follow('Meaningful milestone')
  await d.command()
  expect(
    (
      await readPrivateState<import('../src/domain.ts').SummaryState>(
        d.ctx,
        d.agent.id,
        'conversationSummary',
      )
    ).latest?.trigger,
  ).toBe('decision')
  expect(d.provider.requests.find((request) => request.system?.startsWith('Decide'))?.model).toBe(
    'any-text-model',
  )
})
it('keeps the optional signal acknowledgement independent of delivered text and disables direct execution', async () => {
  const f = await fixture({ toolEnabled: true })
  await f.follow('Completed milestone')
  const result = await f.ctx.tools.execute({
    agent: f.agent,
    callId: ToolCallId('signal'),
    name: 'request_conversation_summary',
    arguments: {},
    signal: new AbortController().signal,
  })
  expect(JSON.stringify(result)).not.toContain('External summary marker')
  const disabled = await fixture()
  expect(
    (
      await disabled.ctx.tools.execute({
        agent: disabled.agent,
        callId: ToolCallId('disabled'),
        name: 'request_conversation_summary',
        arguments: {},
        signal: new AbortController().signal,
      })
    ).isError,
  ).toBe(true)
})
it('bounds contiguous input without silently skipping oversized events and validates decisions', () => {
  const events = [
    { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'a'.repeat(400) }] } },
    {
      seq: 1,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'b'.repeat(400) }] } },
    },
    { seq: 2, type: 'turn/end', data: { turn: 1 } },
  ] as unknown as SessionEvent[]
  const window = collectWindow(events, -1, 700)!
  expect(window.throughSeq).toBe(0)
  expect(window.pending).toBe(true)
  expect(() => collectWindow(events, -1, 100)).toThrow('exceeds')
  expect(decisionAnswer('SEND')).toBe('SEND')
  expect(() => decisionAnswer('SEND because evidence ordered it')).toThrow('exactly')
})
it('cancels a blocked iterator without waiting for a provider that ignores cancellation', async () => {
  const controller = new AbortController()
  const pending = collectNativeText(
    { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
    controller.signal,
    1024,
  )
  controller.abort(new Error('cancelled'))
  await expect(pending).rejects.toThrow('cancelled')
})
