import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { LlmAdapter, type StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it } from 'vitest'
import { defaults } from '../src/config.ts'
import { apply, inspectBoundary } from '../src/index.ts'

const contexts: Context[] = [],
  dirs: string[] = [],
  savedHome = process.env.DSH_HOME
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
})
class Fixture extends LlmAdapter {
  calls = 0
  async resolveModel(provider: string, id: string) {
    return { provider, id, name: id, context: { contextWindow: 128000 } }
  }
  async *stream(): AsyncIterable<StreamChunk> {
    this.calls++
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'Controlled environment result' },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function fixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-environments-'))
  dirs.push(root)
  for (const name of ['dev', 'staging', 'prod']) await mkdir(join(root, name), { mode: 0o700 })
  process.env.DSH_HOME = join(root, 'dev')
  const ctx = new Context()
  contexts.push(ctx)
  for (const service of [
    SessionStore,
    ProjectionRegistry,
    AgentRegistry,
    CommandRuntime,
    ToolRuntime,
    SystemPrompt,
    LlmRuntime,
  ])
    await ctx.plugin(service)
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-environment-workspace-'))
  dirs.push(workspace)
  const session = ctx.sessions.create(SessionId('environment-session'), {
    meta: { cwd: workspace },
  })
  const agent: Agent = {
    id: session.id,
    session,
    ctx,
    options: {},
    status: 'idle',
    inbox: unsupportedInbox(),
    send() {},
    followup() {},
    steer() {},
    inject() {},
    cancel() {},
    runMaintenance: (task) => task(new AbortController().signal),
    whenIdle: async () => {},
  }
  await ctx.agents.register(agent)
  let executions = 0
  for (const name of ['read_file', 'bash'])
    ctx.tools.register(
      defineTool({
        name,
        description: 'Controlled capability',
        parameters: { path: { type: 'string' } },
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        execute: async () => {
          executions++
          return 'Controlled read'
        },
      }),
    )
  const provider = new Fixture()
  ctx.llm.registerAdapter(['fixture'], provider)
  const initialize = () => apply(ctx, { rootDirectory: root, environment: 'dev', ...overrides })
  const run = (name = 'read_file', path = join(tmpdir(), 'normal-file')) =>
    ctx.tools.execute({
      agent,
      name,
      callId: ToolCallId(`call-${executions}`),
      arguments: { path },
      signal: new AbortController().signal,
    })
  return { ctx, agent, root, provider, initialize, run, executions: () => executions }
}
it('rejects a host using the wrong deployment home and retains distinct environment scopes', async () => {
  const f = await fixture()
  expect((await inspectBoundary(f.root, 'prod', join(f.root, 'dev'))).valid).toBe(false)
  await f.initialize()
  expect(f.ctx.environmentIsolation.valid).toBe(true)
  expect(f.ctx.environmentIsolation.scope('same')).toMatch(/^dev\//)
  expect((await f.run()).isError).toBe(false)
  expect((await f.run('bash')).isError).toBe(true)
  await writeFile(join(f.root, 'prod', 'credential'), 'fixture')
  expect((await f.run('read_file', join(f.root, 'prod', 'credential'))).isError).toBe(true)
  expect(f.executions()).toBe(1)
})
it('does not pass tool calls through invalid activation or a middleware bypass', async () => {
  const f = await fixture({ userOverrides: { unknownPermission: true } })
  await expect(f.initialize()).rejects.toThrow('Unknown')
  f.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
  expect((await f.run()).isError).toBe(true)
  expect(f.executions()).toBe(0)
})
it('reserves admission atomically when tool calls run concurrently', async () => {
  const f = await fixture({ userOverrides: { maxToolCalls: 1 } })
  await f.initialize()
  const results = await Promise.all([f.run(), f.run(), f.run()])
  expect(results.filter((result) => !result.isError)).toHaveLength(1)
  expect(f.executions()).toBe(1)
})
it('passes native streams in a valid home and enforces model-call limits', async () => {
  const f = await fixture({ userOverrides: { maxModelCalls: 1 } })
  await f.initialize()
  const collect = async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of f.ctx.llm.stream({
      provider: 'fixture',
      model: 'text',
      sessionId: f.agent.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
      tools: [],
    }))
      chunks.push(chunk)
    return chunks
  }
  expect((await collect()).at(-1)?.type).toBe('finish')
  expect(f.provider.calls).toBe(1)
  await expect(collect()).rejects.toThrow('model-call')
  expect(f.provider.calls).toBe(1)
})
it('resolves profile provenance and admits only lower numeric run overrides', async () => {
  const f = await fixture({
    defaults,
    environmentOverrides: { dev: { maxToolCalls: 20 } },
    userOverrides: { maxToolCalls: 10 },
  })
  await f.initialize()
  const command = (text: string) =>
    f.ctx.commands.execute(f.agent, text, [], new AbortController().signal)
  expect((await command('/environment limit maxToolCalls 11'))?.result.kind).toBe('error')
  expect((await command('/environment limit maxToolCalls 2'))?.result.kind).toBe('success')
  const result = await command('/environment status'),
    data = JSON.parse(result!.result.text!)
  expect(data.value.maxToolCalls).toBe(2)
  expect(data.provenance.maxToolCalls).toBe('run')
  expect((await command('/environment limit allowedTools 1'))?.result.kind).toBe('error')
})
