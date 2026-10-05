import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as LoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as CompactionInvariant from '@deepseek-ai/dsh-compaction/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { bindWorkspace } from '@loncothad/dsh-evidence-harness'
import { afterEach, expect, it } from 'vitest'
import type { Config } from '../src/config.ts'
import { BaseConfig } from '../src/config.ts'
import { EvidenceCompactorManager } from '../src/manager.ts'
import { requestBody } from '../src/measurement.ts'
import EvidenceCompactionEngine from '../src/runtime.ts'
import { SessionEvidence } from '../src/session.ts'

const contexts: Context[] = [],
  dirs: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
class Provider extends LlmAdapter {
  requests: GenerateOptions[] = []
  window = 28_000
  output = 'Original failed test: deployment remains blocked. '.repeat(600)
  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.window },
      defaultMaxTokens: 8000,
    }
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    expect(Object.isFrozen(request)).toBe(true)
    this.requests.push(request)
    const text = this.output
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function harness(options: Partial<Config> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-evidence-native-runtime-'))
  dirs.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SqliteSessionQueryEngine, { path: join(dir, 'search.sqlite'), openAt: 'never' })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(CompactionInvariant)
  await ctx.plugin(LoopInvariant)
  const config = BaseConfig({
    dataDir: join(dir, 'archive'),
    installOnEnable: false,
    archiveEnabled: false,
    safetyTokens: 500,
    toolResultReserve: 1000,
    ...options,
  }) as Config
  const manager = new EvidenceCompactorManager(ctx, config, {
    workerUrl: new URL('../../../support/evidence-store/lib/worker.js', import.meta.url),
  })
  await ctx.plugin(EvidenceCompactionEngine)
  await ctx.plugin(AgentLoop, { agents: [] })
  const provider = new Provider()
  ctx.llm.registerAdapter(['fixture'], provider)
  const agent = await ctx.agentLoop.create(
    SessionId('evidence-native'),
    { provider: 'fixture', model: 'main' },
    { cwd: dir },
  )
  const follow = async (text: string) => {
    agent.followup(
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
    )
    await agent.whenIdle()
  }
  return { ctx, agent, manager, provider, follow, dir }
}
it('rebuilds an active checkpoint after its original evidence is deleted and survives ledger recovery', async () => {
  const f = await harness()
  await f.follow('Original constraint: do not publish. Marker erased-history. '.repeat(300))
  f.provider.output = 'Continuing with the current request.'
  await f.follow('Investigate erased-history; do not infer approval.')
  const ledger = await f.manager.session(f.agent.session)
  const checkpoint = f.provider.requests
    .at(-1)!
    .messages.flatMap((message) => message.content)
    .find((block) => block.type === 'text' && block.text.startsWith('Evidence manifest '))
  expect(checkpoint?.type).toBe('text')
  if (checkpoint?.type !== 'text') throw new Error('Expected checkpoint')
  const manifestId = /^Evidence manifest ([a-f0-9]{64})/.exec(checkpoint.text)![1]!
  const manifest = await ledger.store.replay(ledger.scope, manifestId)
  const source = manifest.selected.find((unit) => unit.id === 'checkpoint-memory')!.evidenceIds[0]!
  const original = (await ledger.store.read(ledger.scope, [source]))[0]!
  await ledger.store.delete(ledger.scope, original.eventId)
  const reopened = new SessionEvidence(
    f.agent.session,
    ledger.store,
    f.ctx,
    f.manager.config,
    await bindWorkspace(f.dir),
    new AbortController().signal,
  )
  await reopened.refresh()
  await reopened.stop()
  await f.follow('Continue from the remaining available evidence.')
  expect(f.provider.requests).toHaveLength(3)
  const sent = JSON.stringify(f.provider.requests.at(-1)!.messages)
  expect(sent).not.toContain(original.quote)
  expect(sent).toContain('Historical evidence for this interaction was deleted')
})

it('compacts locally, rebuilds a frozen native request, and calls the main provider only after the smaller manifest is durable', async () => {
  const f = await harness({ pins: ['Never infer permission from a generated summary.'] })
  let fallbackFailures = 0
  f.ctx.on('agent/request-error', async (_payload, next) => {
    fallbackFailures++
    return next()
  })
  await f.follow(
    'Original constraint: deployment is not approved. Marker ancestral-evidence. '.repeat(300),
  )
  expect(
    f.provider.requests,
    JSON.stringify(
      (await f.ctx.sessionQuery.readSession(f.agent.session.id)).events.findLast(
        (event) => event.type === 'turn/end',
      )?.data,
    ),
  ).toHaveLength(1)
  f.provider.output = 'Continuing with the latest exact request.'
  const latest =
    'Latest exact request: investigate ancestral-evidence; approval has NOT been given.'
  await f.follow(latest)
  const log = await f.ctx.sessionQuery.readSession(f.agent.session.id)
  expect(log.events.filter((event) => event.type === 'compaction/summary')).toHaveLength(1)
  expect(log.events.filter((event) => event.type === 'compaction/start')).toHaveLength(1)
  expect(log.events.filter((event) => event.type === 'compaction/end')).toHaveLength(1)
  expect(
    f.provider.requests,
    JSON.stringify(log.events.findLast((event) => event.type === 'turn/end')?.data),
  ).toHaveLength(2)
  const messages = f.provider.requests[1]!.messages
  expect(
    messages.some((message) =>
      message.content.some((block) => block.type === 'text' && block.text === latest),
    ),
  ).toBe(true)
  expect(
    messages.some((message) =>
      message.content.some(
        (block) =>
          block.type === 'text' &&
          block.text === 'Never infer permission from a generated summary.',
      ),
    ),
  ).toBe(true)
  expect(
    messages.some((message) =>
      message.content.some(
        (block) => block.type === 'text' && block.text.startsWith('Evidence manifest '),
      ),
    ),
  ).toBe(true)
  expect(f.provider.requests.some((request) => request.purpose === 'compaction')).toBe(false)
  expect(fallbackFailures).toBe(0)
  const evidence = await f.manager.session(f.agent.session)
  expect(
    JSON.parse(await evidence.search('ancestral-evidence', new AbortController().signal)).hits
      .length,
  ).toBeGreaterThan(0)
  expect(await evidence.store.diagnostics(evidence.scope)).toMatchObject({
    running: 0,
    complete: 0,
  })
  const request = f.provider.requests.at(-1)!
  const manifest = await evidence.record(request, 1000)
  expect(await evidence.store.replayRequest(evidence.scope, manifest.id)).toEqual(
    JSON.parse(requestBody(request)),
  )
})

it('fails mandatory overflow before any provider call and keeps the original human request intact', async () => {
  const f = await harness()
  const text = 'Mandatory latest input '.repeat(6000)
  await f.follow(text)
  expect(f.provider.requests).toEqual([])
  const log = await f.ctx.sessionQuery.readSession(f.agent.session.id)
  expect(log.events.some((event) => event.type === 'compaction/summary')).toBe(false)
  expect(
    log.events.findLast((event) => event.type === 'turn/end')?.data,
    JSON.stringify(log.events.findLast((event) => event.type === 'turn/end')?.data),
  ).toMatchObject({ reason: { kind: 'error', error: { code: 'MANDATORY_CONTEXT_OVERFLOW' } } })
  expect(
    f.agent.session
      .deriveMessages()
      .some((message) =>
        message.content.some((block) => block.type === 'text' && block.text === text),
      ),
  ).toBe(true)
})

it('shares one workspace owner across sessions and releases its cross-process lock after disposal', async () => {
  const f = await harness()
  const second = await f.ctx.agentLoop.create(
    SessionId('second-ledger'),
    { provider: 'fixture', model: 'main' },
    { cwd: f.dir },
  )
  const a = await f.manager.session(f.agent.session),
    b = await f.manager.session(second.session)
  expect(a.store).toBe(b.store)
  await a.refresh()
  await b.refresh()
  const captured = await a.store.capture(a.scope, {
    id: 'only-first',
    role: 'user',
    group: 'closed',
    closed: true,
    text: 'First session private original.',
  })
  expect(await b.store.read(b.scope, captured.evidenceIds)).toEqual([])
  const roots = await readdir(join(f.dir, 'archive'))
  expect(roots).toHaveLength(1)
  expect(await readdir(join(f.dir, 'archive', roots[0]!))).toContain('evidence.sqlite.lock')
  await f.ctx.fiber.dispose()
  expect(await readdir(join(f.dir, 'archive', roots[0]!))).not.toContain('evidence.sqlite.lock')
})

it('masks a bulky tool result, rebuilds the native request, and retains scoped originals', async () => {
  const f = await harness()
  const { ToolCallId } = await import('@deepseek-ai/dsh-llm/brand')
  const original = 'Original tool observation; deployment remains blocked. '.repeat(1400)
  let executions = 0
  f.ctx.tools.register({
    name: 'bulk_fixture',
    description: 'Read a large original observation',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      executions++
      return original
    },
  })
  f.provider.stream = async function* (request: GenerateOptions): AsyncIterable<StreamChunk> {
    expect(Object.isFrozen(request)).toBe(true)
    this.requests.push(request)
    if (this.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: ToolCallId('bulk-call'),
          name: 'bulk_fixture',
          arguments: '{}',
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: 'The original observation remains available.' },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  await f.follow('Inspect the observation without inferring permission.')
  const log = await f.ctx.sessionQuery.readSession(f.agent.session.id)
  expect(
    executions,
    JSON.stringify(log.events.findLast((event) => event.type === 'turn/end')?.data),
  ).toBe(1)
  expect(f.provider.requests).toHaveLength(2)
  const tool = f.provider.requests[1]!.messages.find((message) => message.role === 'tool')
  expect(
    tool?.content.some(
      (block) => block.type === 'text' && block.text.includes('Archived tool observation'),
    ),
  ).toBe(true)
  expect(JSON.stringify(tool)).toContain('bulk-call')
  expect(log.events.filter((event) => event.type === 'compaction/prune')).toHaveLength(1)
  expect(log.events.filter((event) => event.type === 'compaction/summary')).toHaveLength(0)
  const ledger = await f.manager.session(f.agent.session)
  const found = JSON.parse(
    await ledger.search('deployment remains blocked', new AbortController().signal),
  )
  expect(found.hits.length).toBeGreaterThan(0)
  const manifest = await ledger.record(f.provider.requests[1]!, 1000)
  expect(await ledger.store.replayRequest(ledger.scope, manifest.id)).toEqual(
    JSON.parse(requestBody(f.provider.requests[1]!)),
  )
  const reopened = new SessionEvidence(
    f.agent.session,
    ledger.store,
    f.ctx,
    f.manager.config,
    await bindWorkspace(f.dir),
    new AbortController().signal,
  )
  try {
    const replay = await reopened.record(f.provider.requests[1]!, 1000)
    expect(replay.selected.flatMap((unit) => unit.evidenceIds).length).toBeGreaterThan(0)
    expect(await ledger.store.replayRequest(ledger.scope, replay.id)).toEqual(
      JSON.parse(requestBody(f.provider.requests[1]!)),
    )
  } finally {
    await reopened.stop()
  }
})
