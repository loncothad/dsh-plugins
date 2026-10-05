import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  mountAgentLoopTestDependencies,
  unsupportedInbox,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import { LlmAdapter, type StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { readPrivateState } from '@loncothad/dsh-plugin-runtime'
import { afterEach, expect, it, vi } from 'vitest'
import { apply as recovery } from '../../execution-recovery/src/index.ts'
import { apply } from '../src/index.ts'
import type { AssuranceState } from '../src/view.ts'

const contexts: Context[] = [],
  dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
const contract = {
  id: 'check',
  minimumIndependentSources: 0,
  freshnessMs: 300000,
  requireDatabaseRead: false,
  verifiers: ['file-check'],
  requireModelVerifier: false,
  requireHumanReview: false,
}
class Model extends LlmAdapter {
  async resolveModel(provider: string, id: string) {
    return { provider, id, name: id, context: { contextWindow: 128000 } }
  }
  async *stream(): AsyncIterable<StreamChunk> {
    const text =
      '{"passed":true,"reason":"The candidate claims success; this remains only a model opinion."}'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function fixture(modelOnly = false, database = false) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-assurance-work-')),
    privateDir = await mkdtemp(join(tmpdir(), 'dsh-assurance-private-'))
  dirs.push(workspace, privateDir)
  await writeFile(join(workspace, 'task.txt'), 'original')
  await writeFile(join(privateDir, 'database.txt'), 'complete')
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  if (!ctx.get('goals')) await ctx.plugin(GoalService)
  await ctx.plugin(SqliteSessionQueryEngine, {
    path: join(privateDir, 'query.sqlite'),
    openAt: 'never',
  })
  ctx.on('session/flush', () => {})
  const session = ctx.sessions.create(SessionId('assurance-session'), { meta: { cwd: workspace } }),
    agent: Agent = {
      id: session.id,
      session,
      ctx,
      options: { provider: 'generation', model: 'generator' },
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
  ctx.goals.create(agent, { objective: 'task.txt must contain complete' })
  ctx.llm.registerAdapter(['validation'], new Model())
  await recovery(
    ctx,
    { dataDir: join(privateDir, 'recovery') },
    {
      workerUrl: new URL('../../../support/execution-core/lib/journal-worker.js', import.meta.url),
    },
  )
  await apply(ctx, {
    stateDirectory: join(privateDir, 'state'),
    contracts: [
      modelOnly
        ? { ...contract, verifiers: [], requireModelVerifier: true }
        : database
          ? { ...contract, freshnessMs: 10000, requireDatabaseRead: true }
          : contract,
    ],
    goalContract: 'check',
    verifiers: modelOnly
      ? []
      : [
          {
            id: 'file-check',
            command: process.execPath,
            arguments: [
              '-e',
              `require('node:assert/strict').equal(require('node:fs').readFileSync(require('node:path').join(process.argv[1],${JSON.stringify(database ? 'database.txt' : 'task.txt')}),'utf8'),'complete')`,
              database ? privateDir : '{workspace}',
            ],
            kind: database ? 'database-read' : 'verification',
          },
        ],
    modelVerification: modelOnly,
    verifierProvider: 'validation',
    verifierModel: 'checker',
    skillEnabled: false,
  })
  const command = (text: string) =>
    ctx.commands.execute(agent, text, [], new AbortController().signal)
  return { ctx, agent, workspace, privateDir, command }
}
it('does not complete a declared workflow until its executable evidence passes', async () => {
  const f = await fixture()
  await f.command('/workflow start check :: task.txt contains complete')
  expect((await f.command('/workflow complete'))?.result.kind).toBe('error')
  await f.command('/assurance verify check')
  expect(f.ctx.evidenceAuthority.check(f.agent.id).state).toBe('insufficient_evidence')
  await writeFile(join(f.workspace, 'task.txt'), 'complete')
  await f.command('/assurance verify check')
  expect(f.ctx.evidenceAuthority.check(f.agent.id).state).toBe('verified')
  expect((await f.command('/workflow complete'))?.result.kind).toBe('success')
})
it('invalidates evidence after actual workspace bytes change outside model tools', async () => {
  const f = await fixture()
  await writeFile(join(f.workspace, 'task.txt'), 'complete')
  await f.command('/assurance verify check')
  expect(f.ctx.evidenceAuthority.check(f.agent.id).state).toBe('verified')
  await writeFile(join(f.workspace, 'task.txt'), 'regressed')
  await f.ctx.evidenceAuthority.refresh(f.agent.id)
  expect(f.ctx.evidenceAuthority.check(f.agent.id).state).toBe('insufficient_evidence')
})
it('treats a separate model pass as unverified when no grounded checks exist', async () => {
  const f = await fixture(true)
  await f.ctx.tools.execute({
    agent: f.agent,
    name: 'submit_evidence_output',
    callId: ToolCallId('candidate'),
    arguments: { output: 'The task is complete.' },
    signal: new AbortController().signal,
  })
  await f.command('/assurance verify check')
  expect(f.ctx.evidenceAuthority.check(f.agent.id).state).toBe('unverified')
  expect(
    (await readPrivateState<AssuranceState>(f.ctx, f.agent.id, 'evidenceAssurance'))?.receipts.some(
      (row) => row.kind === 'model-verifier' && row.passed,
    ),
  ).toBe(true)
})
it('requires review of the exact target and cannot bless an outdated review', async () => {
  const f = await fixture()
  await f.ctx.evidenceAuthority.refresh(f.agent.id)
  const target = f.ctx.evidenceAuthority.currentTarget(f.agent.id)
  await writeFile(join(f.workspace, 'task.txt'), 'changed')
  expect((await f.command(`/assurance approve ${target}`))?.result.kind).toBe('error')
  expect(
    (await readPrivateState<AssuranceState>(f.ctx, f.agent.id, 'evidenceAssurance'))?.receipts,
  ).toHaveLength(0)
})

it('preserves cached observation time and rechecks an expired external database read', async () => {
  const realNow = (Math.floor(Date.now() / 10000) + 1) * 10000 + 2000,
    clock = vi.spyOn(Date, 'now').mockReturnValue(realNow),
    f = await fixture(false, true)
  await f.command('/assurance verify check')
  const first = (await readPrivateState<AssuranceState>(f.ctx, f.agent.id, 'evidenceAssurance'))
    .receipts[0]
  expect(f.ctx.evidenceAuthority.check(f.agent.id), JSON.stringify(first)).toMatchObject({
    state: 'verified',
  })
  await writeFile(join(f.privateDir, 'database.txt'), 'regressed')
  await f.command('/assurance verify check')
  const cached = (
    await readPrivateState<AssuranceState>(f.ctx, f.agent.id, 'evidenceAssurance')
  ).receipts.at(-1)!
  expect(cached.recordedAt).toBe(first.recordedAt)
  clock.mockReturnValue(realNow + 20000)
  expect(f.ctx.evidenceAuthority.check(f.agent.id).state).toBe('insufficient_evidence')
  await f.command('/assurance verify check')
  expect(f.ctx.evidenceAuthority.check(f.agent.id).state).toBe('insufficient_evidence')
  expect(
    (await readPrivateState<AssuranceState>(f.ctx, f.agent.id, 'evidenceAssurance')).receipts.at(
      -1,
    )!.passed,
  ).toBe(false)
})
