import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Commands from '@deepseek-ai/dsh-commands'
import Goals from '@deepseek-ai/dsh-goal'
import {
  type GenerateOptions,
  LlmAdapter,
  type StreamChunk,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { readPrivateState } from '@loncothad/dsh-plugin-runtime'
import { expect, it, vi } from 'vitest'
import type { GoalBook } from '../src/goal-book.ts'
import { apply } from '../src/index.ts'

it('discusses a draft, waits for human approval, fences stale proposals and preserves task evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-goal-review-')),
    ctx = new Context()
  let calls = 0
  const sources: string[] = []
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'user/message') sources.push(event.data.source.kind)
  })
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Commands)
    await ctx.plugin(Goals, { defaultMaxGoalRounds: 1 })
    await ctx.plugin(AgentLoop, { agents: [] })
    class Model extends LlmAdapter {
      async resolveModel(provider: string, id: string) {
        return { provider, id, name: id, context: { contextWindow: 128000 } }
      }
      async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        calls++
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'text', text: 'Draft discussed. Waiting for approval.' },
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['fixture'], new Model())
    const ask = vi.fn(async (request: { questions: { id: string }[] }) => ({
      answers: request.questions.map((q) => ({
        id: q.id,
        selected: ['Tests (Recommended)'],
        custom: 'Also UTF-8',
      })),
    }))
    ctx.provide('userQuestions', { ask } as never)
    await apply(ctx, { stateDirectory: directory, regularRoundLimit: 1, compactAfterTask: false })
    const agent = await ctx.agentLoop.create(SessionId('goal-review-native'), {
        provider: 'fixture',
        model: 'fixture',
      }),
      signal = new AbortController().signal
    const command = (text: string) => ctx.commands.execute(agent, text, [], signal),
      book = () => readPrivateState<GoalBook>(ctx, agent.id, 'goalBook')
    expect((await command('/goal Add CSV export with tests'))?.result.kind).toBe('success')
    await agent.whenIdle()
    expect(ctx.goals.get(agent)).toBeUndefined()
    expect(calls).toBe(1)
    let state = await book()
    let draft = state.goals[0]!
    const proposal = {
      objective: 'Add CSV export',
      criteria: ['CSV export works and tests pass'],
      tasks: [{ title: 'Implement export', acceptance: 'Test fixture confirms output' }],
    }
    const propose = () =>
      ctx.tools.execute({
        agent,
        name: 'propose_goal_draft',
        callId: ToolCallId('proposal'),
        arguments: { id: draft.id, revision: draft.revision, proposal: JSON.stringify(proposal) },
        signal,
      })
    expect((await propose()).isError).toBe(true)
    const clarified = await ctx.tools.execute({
      agent,
      name: 'clarify_goal',
      callId: ToolCallId('clarification'),
      arguments: {
        id: draft.id,
        revision: draft.revision,
        questions: [
          {
            id: 'acceptance',
            question: 'Which acceptance checks?',
            multi_select: true,
            options: [
              { label: 'Tests (Recommended)', description: 'Run the suite' },
              { label: 'Manual check', description: 'Review manually' },
            ],
          },
          {
            id: 'scope',
            question: 'What scope?',
            options: [
              { label: 'CSV only (Recommended)', description: 'Keep the change focused' },
              { label: 'Other formats', description: 'Add formats too' },
            ],
          },
        ],
      },
      signal,
    })
    expect(clarified.isError).toBe(false)
    expect(ask).toHaveBeenCalledOnce()
    expect(ask.mock.calls[0]![0].questions[0]).toMatchObject({ multiSelect: true })
    expect(ask.mock.calls[0]![0].questions[1]).not.toHaveProperty('multiSelect')
    expect(JSON.parse(JSON.stringify(ask.mock.calls[0]![0].questions))).toEqual(
      ask.mock.calls[0]![0].questions,
    )
    expect(sources).toContain('goal-planning')
    draft = (await book()).goals[0]!
    expect(draft.clarifications?.[0]?.answer).toContain('Also UTF-8')
    expect((await propose()).isError).toBe(false)
    expect(ctx.goals.get(agent)).toBeUndefined()
    expect((await propose()).isError).toBe(true)
    state = await book()
    expect(state.goals[0]?.phase).toBe('proposed')
    expect((await command(`/goal-start ${draft.id} 1`))?.result.kind).toBe('error')
    const started = (await command(`/goal-start ${draft.id} ${state.goals[0]!.revision}`))?.result
    if (started?.kind === 'error') throw new Error(started.text)
    expect(started?.kind).toBe('success')
    await agent.whenIdle()
    expect(ctx.goals.get(agent)?.objective).toContain('CSV export works and tests pass')
    state = await book()
    const focused = state.goals.find((row) => row.id === state.focused)!,
      task = focused.tasks[0]!
    expect(
      (
        await ctx.tools.execute({
          agent,
          name: 'goal_task',
          callId: ToolCallId('task'),
          arguments: {
            revision: focused.revision,
            taskId: task.id,
            done: true,
            evidence: 'Fixture export passed',
          },
          signal,
        })
      ).isError,
    ).toBe(false)
    let auditPacket = ''
    let passAudit = false
    class Auditor extends LlmAdapter {
      async resolveModel(provider: string, id: string) {
        return { provider, id, name: id, context: { contextWindow: 128000 } }
      }
      async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        auditPacket = JSON.stringify(request.messages)
        expect(request.system).toContain('no conversation history')
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'text',
            text: JSON.stringify({
              passed: passAudit,
              summary: passAudit ? 'Verifier receipt accepted' : 'CSV needs verifier evidence',
              issues: passAudit
                ? []
                : [
                    {
                      taskId: task.id,
                      reason: 'Unverified encoding',
                      requiredAction: 'Run UTF-8 verifier',
                    },
                  ],
            }),
          },
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['audit-fixture'], new Auditor())
    state = await book()
    expect(
      (
        await command(
          `/goal-settings ${JSON.stringify({ revision: state.revision, settings: { auditMode: 'task', auditorProvider: 'audit-fixture', auditorModel: 'audit', compactAfterTask: true } })}`,
        )
      )?.result.kind,
    ).toBe('success')
    const mark = async () =>
      ctx.tools.execute({
        agent,
        name: 'goal_task',
        callId: ToolCallId('audited-task'),
        arguments: {
          revision: (await book()).goals[0]!.revision,
          taskId: task.id,
          done: true,
          evidence: 'UTF-8 verifier receipt',
        },
        signal,
      })
    expect((await mark()).isError).toBe(true)
    state = await book()
    expect(state.goals[0]!.tasks[0]).toMatchObject({ done: false, auditState: 'rejected' })
    expect(state.goals[0]!.lastAudit?.issues[0]?.requiredAction).toBe('Run UTF-8 verifier')
    expect(auditPacket).not.toContain('Draft discussed')
    expect(
      agent.session
        .snapshotEvents()
        .some((event) => event.type === 'user/message' && event.data.source.kind === 'goal-audit'),
    ).toBe(true)
    expect(
      (
        await ctx.tools.execute({
          agent,
          name: 'update_goal_task',
          callId: ToolCallId('blocked-task'),
          arguments: {
            revision: state.goals[0]!.revision,
            taskId: task.id,
            update: JSON.stringify({
              status: 'blocked',
              reason: 'Need fixture approval',
              nextAction: 'Approve fixture',
            }),
          },
          signal,
        })
      ).isError,
    ).toBe(false)
    state = await book()
    expect(state.goals[0]!.tasks[0]!.reason).toBe('Need fixture approval')
    expect(
      (
        await ctx.tools.execute({
          agent,
          name: 'report_goal_progress',
          callId: ToolCallId('progress-report'),
          arguments: {
            revision: state.goals[0]!.revision,
            summary: 'Export implemented; encoding blocked',
            nextAction: 'Obtain fixture approval',
          },
          signal,
        })
      ).isError,
    ).toBe(false)
    const compact = vi.fn(async () => null)
    ctx.provide('compaction', { compactNow: compact } as never)
    passAudit = true
    expect((await mark()).isError).toBe(false)
    await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce())
    expect((await command('/goal-tweak Also include UTF-8 headers'))?.result.kind).toBe('success')
    await agent.whenIdle()
    state = await book()
    expect(state.draft).toBe(focused.id)
    expect(state.goals[0]?.tasks[0]).toMatchObject({
      done: true,
      evidence: 'UTF-8 verifier receipt',
    })
    expect((await command('/goal-cancel'))?.result.kind).toBe('success')
    expect((await book()).draft).toBeUndefined()
    await vi.waitFor(() => expect(ctx.goals.get(agent)?.phase).toBe('paused'))
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
