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

it.each(['regular', 'sisyphus'] as const)(
  '%s amends the same goal and archives a source only after fresh activation',
  async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-goal-edits-')),
      ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(Commands)
      await ctx.plugin(Goals, { defaultMaxGoalRounds: 1 })
      await ctx.plugin(AgentLoop, { agents: [] })
      class Model extends LlmAdapter {
        async resolveModel(provider: string, id: string) {
          return { provider, id, name: id, context: { contextWindow: 128000 } }
        }
        async *stream(_request: GenerateOptions): AsyncIterable<StreamChunk> {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield {
            type: 'block-end',
            index: 0,
            block: { type: 'text', text: 'Waiting for explicit review.' },
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
      ctx.llm.registerAdapter(['fixture'], new Model())
      await apply(ctx, {
        stateDirectory: dir,
        regularRoundLimit: 1,
        sisyphusRoundLimit: 1,
        auditMode: 'off',
        requireClarification: false,
        compactAfterTask: false,
      })
      const agent = await ctx.agentLoop.create(SessionId('goal-edits'), {
          provider: 'fixture',
          model: 'fixture',
        }),
        signal = new AbortController().signal
      const command = async (text: string) => {
        const r = (await ctx.commands.execute(agent, text, [], signal))?.result
        if (r?.kind !== 'success') throw Error(r?.text ?? 'Missing command')
        return r
      }
      const book = () => readPrivateState<GoalBook>(ctx, agent.id, 'goalBook')
      const tool = (name: string, args: Record<string, unknown>) =>
        ctx.tools.execute({
          agent,
          name,
          callId: ToolCallId(`fixture-${name}-${Date.now()}`),
          arguments: args,
          signal,
        })
      const propose = async (objective: string, tasks: unknown[]) => {
        const b = await book(),
          g = b.goals.find((g) => g.id === b.draft)!
        const r = await tool('propose_goal_draft', {
          id: g.id,
          revision: g.revision,
          proposal: JSON.stringify({ objective, criteria: ['Checks pass'], tasks }),
        })
        expect(r.isError, JSON.stringify(r)).toBe(false)
      }
      const accept = async () => {
        const b = await book(),
          g = b.goals.find((g) => g.id === b.draft)!
        await command(`/goal-start ${g.id} ${g.revision}`)
        await agent.whenIdle()
      }
      await command(`${kind === 'sisyphus' ? '/sisyphus' : '/goal'} CSV export`)
      await agent.whenIdle()
      await propose('CSV export', [
        { title: 'Implement', acceptance: 'Export fixture passes' },
        { title: 'Verify encoding', acceptance: 'Encoding fixture passes' },
      ])
      await accept()
      let b = await book(),
        g = b.goals.find((g) => g.id === b.focused)!,
        done = g.tasks[0]!,
        pending = g.tasks[1]!
      if (kind === 'regular') {
        expect(
          (
            await tool('goal_task', {
              revision: g.revision,
              taskId: done.id,
              done: true,
              evidence: 'Export fixture receipt',
            })
          ).isError,
        ).toBe(false)
      } else {
        let native = ctx.goals.get(agent)!
        ctx.goals.edit(agent, { id: native.id, revision: native.revision }, { maxGoalRounds: 2 })
        native = ctx.goals.get(agent)!
        ctx.goals.disarm(agent)
        ctx.goals.resume(agent, { id: native.id, revision: native.revision })
        ctx.goals.disarm(agent)
        await vi.waitFor(async () =>
          expect(
            (
              await readPrivateState<import('../src/types.ts').SisyphusPlan>(
                ctx,
                agent.id,
                'sisyphus',
              )
            ).phase,
          ).toBe('active'),
        )
        let plan = await readPrivateState<import('../src/types.ts').SisyphusPlan>(
          ctx,
          agent.id,
          'sisyphus',
        )
        expect(
          (
            await tool('sisyphus_step', {
              revision: plan.revision,
              action: 'complete',
              evidence: 'Export fixture receipt',
            })
          ).isError,
        ).toBe(false)
        plan = await readPrivateState<import('../src/types.ts').SisyphusPlan>(
          ctx,
          agent.id,
          'sisyphus',
        )
        await command(`/sisyphus approve ${plan.revision} Export fixture receipt`)
        await agent.whenIdle()
      }
      const nativeBefore = ctx.goals.get(agent)!
      await command('/goal-tweak Add TSV support')
      await agent.whenIdle()
      b = await book()
      expect(b.draft).toBe(g.id)
      expect(b.draftOperation?.kind).toBe('tweak')
      expect(
        (
          await tool('report_goal_progress', {
            revision: b.goals[0]!.revision,
            summary: 'Mutated too early',
            nextAction: 'Continue',
          })
        ).isError,
      ).toBe(true)
      expect(
        (await ctx.commands.execute(agent, '/goal-replace Wrong concurrent draft', [], signal))
          ?.result.kind,
      ).toBe('error')
      await propose('CSV and TSV export', [
        { id: pending.id, title: pending.title, acceptance: pending.acceptance },
        { title: 'TSV support', acceptance: 'TSV fixture passes' },
      ])
      await accept()
      b = await book()
      g = b.goals.find((x) => x.id === b.focused)!
      expect(g.id).toBe(b.goals[0]?.id)
      expect(g.tasks[0]).toMatchObject({
        id: done.id,
        done: true,
        evidence: 'Export fixture receipt',
      })
      expect(g.tasks[1]?.id).toBe(pending.id)
      expect(ctx.goals.get(agent)?.id).toBe(nativeBefore.id)
      expect(ctx.goals.get(agent)?.roundsStarted).toBe(nativeBefore.roundsStarted)
      expect(ctx.goals.get(agent)?.maxGoalRounds).toBe(nativeBefore.maxGoalRounds)
      await command('/goal-replace New parser')
      await agent.whenIdle()
      b = await book()
      const cancelled = b.draft
      expect(b.draft).not.toBe(g.id)
      expect(b.focused).toBe(g.id)
      expect(b.goals.find((x) => x.id === g.id)?.phase).toBe('paused')
      await command('/goal-cancel')
      b = await book()
      expect(b.goals.some((x) => x.id === cancelled)).toBe(false)
      expect(b.focused).toBe(g.id)
      await command('/goal-replace New parser')
      await agent.whenIdle()
      b = await book()
      await command(
        `/goal-settings ${JSON.stringify({ revision: b.revision, settings: { auditMode: 'off', compactAfterTask: false } })}`,
      )
      await propose('New parser', [{ title: 'Parse JSON', acceptance: 'Parser fixture passes' }])
      await accept()
      b = await book()
      const replacement = b.goals.find((x) => x.id === b.focused)!,
        old = b.goals.find((x) => x.id === g.id)!
      expect(replacement.id).not.toBe(g.id)
      expect(replacement.replaces).toBe(g.id)
      expect(replacement.tasks).toHaveLength(1)
      expect(replacement.tasks[0]?.done).toBe(false)
      expect(replacement.tasks[0]?.evidence).toBeUndefined()
      expect(old.phase).toBe('archived')
      expect(old.replacedBy).toBe(replacement.id)
      expect(old.tasks[0]?.evidence).toBe('Export fixture receipt')
      expect(b.draftOperation).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  },
  20000,
)
