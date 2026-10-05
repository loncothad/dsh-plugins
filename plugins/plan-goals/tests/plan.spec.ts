import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { readPrivateState } from '@loncothad/dsh-plugin-runtime'
import { afterEach, expect, it, vi } from 'vitest'
import type { Policy } from '../src/config.ts'
import { advance, apply, foldPlan, parseSteps, resolvePolicy } from '../src/index.ts'
import type { SisyphusPlan } from '../src/types.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const first: SisyphusPlan = {
  id: 'e5001eaa-c5a5-47b9-8ba4-fbb177566cc4',
  revision: 1,
  goalId: 'goal-test',
  title: 'Release',
  steps: [
    { title: 'Audit', acceptance: 'Tests pass' },
    { title: 'Package', acceptance: 'Tarballs import' },
  ],
  index: 0,
  failures: 0,
  phase: 'active',
}
it('requires criteria, bounds plans, and never advances out of order', () => {
  expect(
    parseSteps('Release :: Audit | Tests pass; Package | Tarballs import', 2).steps,
  ).toHaveLength(2)
  expect(() => parseSteps('Release :: Audit', 2)).toThrow('acceptance')
  expect(() => parseSteps('Release :: A | yes; B | yes', 1)).toThrow('1–1')
  expect(() => advance(first, 2, 'passed', 2048)).toThrow('changed')
  expect(() => advance(first, 1, '', 2048)).toThrow('evidence')
  const next = advance(first, 1, 'Tests pass', 2048)
  expect(next.index).toBe(1)
  expect(first.steps[0]?.evidence).toBeUndefined()
  expect(advance(next, 2, 'All imports passed', 2048).phase).toBe('complete')
})
it('strict replay rejects missing revisions and preserves evidence through checkpoint replay', () => {
  const event = (plan: SisyphusPlan | null) => ({
    type: 'plan-goals/change',
    data: { version: 1, plan },
  })
  const next = advance(first, 1, 'Tests pass', 2048)
  expect(foldPlan(foldPlan(null, event(first)), event(next))).toEqual(next)
  expect(() => foldPlan(first, event({ ...next, revision: 7 }))).toThrow('revision')
  expect(foldPlan(next, event(null))).toBeNull()
})
async function fixture(policy: Partial<Policy> = {}) {
  const ctx = new Context(),
    directory = await mkdtemp(join(tmpdir(), 'dsh-plan-private-'))
  directories.push(directory)
  for (const service of [
    SessionStore,
    ProjectionRegistry,
    AgentRegistry,
    CommandRuntime,
    ToolRuntime,
    SystemPrompt,
  ])
    await ctx.plugin(service)
  await ctx.plugin(GoalService, { defaultMaxGoalRounds: 100 })
  const session = ctx.sessions.create(SessionId('plan-test'))
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
  await apply(ctx, { ...policy, stateDirectory: directory })
  const command = (raw: string) =>
    ctx.commands.execute(agent, raw, [], new AbortController().signal)
  return { ctx, agent, command }
}
it('uses native lifecycle, rejects stale human approvals, pauses and preserves evidence', async () => {
  const { ctx, agent, command } = await fixture()
  try {
    expect(
      (await command('/sisyphus Release :: Audit | Tests pass; Package | Imports pass'))?.result
        .kind,
    ).toBe('success')
    const read = async () => await readPrivateState<SisyphusPlan>(ctx, agent.id, 'sisyphus')
    expect(ctx.goals.get(agent)?.maxGoalRounds).toBe(128)
    expect((await command('/sisyphus approve 9 tests passed'))?.result.kind).toBe('error')
    expect((await command('/sisyphus pause'))?.result.kind).toBe('success')
    expect((await command('/sisyphus approve 2 tests passed'))?.result.kind).toBe('error')
    expect(ctx.goals.get(agent)?.activation).toBe('disarmed')
    await command('/sisyphus resume')
    await command(`/sisyphus approve ${(await read()).revision} tests passed`)
    expect((await read()).index).toBe(1)
    expect(ctx.goals.get(agent)?.objective).toContain('Step 2/2')
    await command(`/sisyphus approve ${(await read()).revision} imports passed`)
    expect((await read()).phase).toBe('complete')
    expect(ctx.goals.get(agent)?.phase).toBe('complete')
  } finally {
    await ctx.fiber.dispose()
  }
})
it('edits regular goal limits through exact native revisions without changing create acknowledgements', async () => {
  const { ctx, agent } = await fixture()
  try {
    const goal = ctx.goals.create(agent, { objective: 'Research the API' })
    expect(ctx.goals.get(agent)?.revision).toBe(goal.revision)
    expect(ctx.goals.get(agent)?.maxGoalRounds).toBe(100)
    const response = await ctx.commands.execute(
      agent,
      `/goal-rounds ${goal.id} ${goal.revision} 64`,
      [],
      new AbortController().signal,
    )
    expect(response?.result.kind).toBe('success')
    expect(ctx.goals.get(agent)?.maxGoalRounds).toBe(64)
  } finally {
    await ctx.fiber.dispose()
  }
})
it('bounds policy text and resolves review-safe defaults', () => {
  expect(resolvePolicy({}).checkpointMode).toBe('human')
  expect(resolvePolicy({}).modelAdvance).toBe(false)
  expect(() => resolvePolicy({ goalGuidance: 'x'.repeat(16385) })).toThrow('16 KiB')
})

it('records a completion proposal and pauses instead of repeatedly driving an unapproved step', async () => {
  const { ctx, agent, command } = await fixture()
  try {
    await command('/sisyphus Release :: Audit | Tests pass; Package | Imports pass')
    const result = await ctx.tools.execute({
      name: 'sisyphus_step',
      callId: ToolCallId('proposal'),
      agent,
      arguments: { revision: 1, action: 'complete', evidence: 'All tests passed' },
      signal: new AbortController().signal,
    })
    expect(result.isError, JSON.stringify(result)).toBe(false)
    let plan = await readPrivateState<SisyphusPlan>(ctx, agent.id, 'sisyphus')
    expect(plan.phase).toBe('review')
    expect(plan.index).toBe(0)
    expect(plan.pendingEvidence).toBe('All tests passed')
    expect(ctx.goals.get(agent)?.phase).toBe('paused')
    expect(ctx.goals.get(agent)?.activation).toBe('disarmed')
    expect((await command('/sisyphus approve 1 stale'))?.result.kind).toBe('error')
    await command('/sisyphus approve 2 All tests passed')
    plan = await readPrivateState<SisyphusPlan>(ctx, agent.id, 'sisyphus')
    expect(plan.index).toBe(1)
    expect(plan.pendingEvidence).toBeUndefined()
    expect(ctx.goals.get(agent)?.phase).toBe('active')
  } finally {
    await ctx.fiber.dispose()
  }
})
it('blocks repeated step failures and prevents direct execution when checkpoint tools are disabled', async () => {
  const { ctx, agent, command } = await fixture({ maxStepFailures: 2 })
  try {
    await command('/sisyphus Release :: Audit | Tests pass')
    for (let revision = 1; revision <= 2; revision++)
      expect(
        (
          await ctx.tools.execute({
            name: 'sisyphus_step',
            callId: ToolCallId(`failure-${revision}`),
            agent,
            arguments: {
              revision,
              action: 'fail',
              evidence: 'The required service is unavailable',
            },
            signal: new AbortController().signal,
          })
        ).isError,
      ).toBe(false)
    expect(ctx.goals.get(agent)?.phase).toBe('blocked')
    await command('/sisyphus resume')
    expect(ctx.goals.get(agent)?.phase).toBe('active')
  } finally {
    await ctx.fiber.dispose()
  }
  const disabled = await fixture({ modelTools: false })
  try {
    expect(
      (
        await disabled.ctx.tools.execute({
          name: 'get_sisyphus',
          callId: ToolCallId('disabled'),
          agent: disabled.agent,
          arguments: {},
          signal: new AbortController().signal,
        })
      ).isError,
    ).toBe(true)
  } finally {
    await disabled.ctx.fiber.dispose()
  }
})

it('synchronizes native pause/resume and preserves completed evidence while revising future steps', async () => {
  const { ctx, agent, command } = await fixture()
  try {
    await command('/sisyphus Release :: Audit | Tests pass; Package | Imports pass')
    await command('/sisyphus approve 1 Tests passed')
    let goal = ctx.goals.get(agent)!
    ctx.goals.pause(agent, { id: goal.id, revision: goal.revision })
    let plan = await readPrivateState<SisyphusPlan>(ctx, agent.id, 'sisyphus')
    expect(plan.phase).toBe('paused')
    goal = ctx.goals.get(agent)!
    ctx.goals.resume(agent, { id: goal.id, revision: goal.revision })
    expect((await readPrivateState<SisyphusPlan>(ctx, agent.id, 'sisyphus')).phase).toBe('active')
    goal = ctx.goals.get(agent)!
    ctx.goals.edit(
      agent,
      { id: goal.id, revision: goal.revision },
      { objective: 'Include declarations in the release' },
    )
    plan = await readPrivateState<SisyphusPlan>(ctx, agent.id, 'sisyphus')
    expect(plan.phase).toBe('paused')
    expect(ctx.goals.get(agent)?.phase).toBe('paused')
    expect((await command('/sisyphus resume'))?.result.kind).toBe('error')
    await command(
      `/sisyphus amend ${plan.revision} Release :: Package | Imports and declarations pass`,
    )
    plan = await readPrivateState<SisyphusPlan>(ctx, agent.id, 'sisyphus')
    expect(plan.steps[0]?.evidence).toBe('Tests passed')
    expect(plan.steps[1]?.acceptance).toBe('Imports and declarations pass')
    await command('/sisyphus resume')
    expect(ctx.goals.get(agent)?.phase).toBe('active')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('starts native automatic continuation only after its ordered checkpoint is durable', async () => {
  const { mountAgentLoopTestDependencies } = await import('@deepseek-ai/dsh-agent-loop-testkit')
  const { default: AgentLoop } = await import('@deepseek-ai/dsh-agent-loop')
  const GoalRounds = await import('@deepseek-ai/dsh-goal-round-driver')
  const { LlmAdapter } = await import('@deepseek-ai/dsh-llm')
  const ctx = new Context(),
    directory = await mkdtemp(join(tmpdir(), 'dsh-plan-native-'))
  directories.push(directory)
  let seen: SisyphusPlan | undefined
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(GoalService)
    await ctx.plugin(GoalRounds)
    await ctx.plugin(AgentLoop, { agents: [] })
    class Provider extends LlmAdapter {
      async resolveModel(provider: string, id: string) {
        return {
          provider,
          id,
          name: id,
          context: { contextWindow: 128000 },
          defaultMaxTokens: 4096,
        }
      }
      async *stream(
        request: import('@deepseek-ai/dsh-llm').GenerateOptions,
      ): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk> {
        const plan = await readPrivateState<SisyphusPlan>(ctx, request.sessionId!, 'sisyphus')
        if (plan.phase !== 'active') {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield {
            type: 'block-end',
            index: 0,
            block: { type: 'text', text: 'Waiting for checkpoint review.' },
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        seen = plan
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: ToolCallId('proposal'),
            name: 'sisyphus_step',
            arguments: JSON.stringify({
              revision: seen.revision,
              action: 'complete',
              evidence: 'Native startup checkpoint was present',
            }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
    ctx.llm.registerAdapter(['fixture'], new Provider())
    const agent = await ctx.agentLoop.create(SessionId('plan-native-startup'), {
      provider: 'fixture',
      model: 'fixture',
    })
    await apply(ctx, { stateDirectory: directory })
    const result = await ctx.commands.execute(
      agent,
      '/sisyphus-direct Qualify startup :: Inspect | Checkpoint is durable',
      [],
      new AbortController().signal,
    )
    expect(result?.result.kind).toBe('success')
    await vi.waitFor(async () =>
      expect((await readPrivateState<SisyphusPlan>(ctx, agent.id, 'sisyphus')).phase).toBe(
        'review',
      ),
    )
    expect(seen).toMatchObject({ revision: 1, index: 0, phase: 'active' })
    expect(ctx.goals.get(agent)).toMatchObject({
      phase: 'paused',
      roundsStarted: 1,
      activation: 'disarmed',
    })
  } finally {
    await ctx.fiber.dispose()
  }
})
