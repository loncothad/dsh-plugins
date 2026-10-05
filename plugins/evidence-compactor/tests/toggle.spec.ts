/** A preset must remain usable while its optional root evidence owner is withdrawn. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import {
  createUserMessage,
  type GenerateOptions,
  LlmAdapter,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { expect, it, vi } from 'vitest'
import { BaseConfig, type Config } from '../src/config.ts'
import { EvidenceCompactorManager } from '../src/manager.ts'
import EvidenceCompactionEngine from '../src/runtime.ts'

it('keeps native compaction available across enable, disable, re-enable and existing-agent continuation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-compactor-toggle-')),
    ctx = new Context()
  let requests = 0
  const native = vi.spyOn(BasicCompactionEngine.prototype, 'compactIfNeeded'),
    manual = vi.spyOn(BasicCompactionEngine.prototype, 'compactNow')
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SqliteSessionQueryEngine, { path: join(dir, 'query.sqlite'), openAt: 'never' })
    await ctx.plugin(TokenMeter)
    await ctx.plugin(EvidenceCompactionEngine, { retainRatio: 0.2 })
    await ctx.plugin(AgentLoop, { agents: [] })
    class Model extends LlmAdapter {
      async resolveModel(provider: string, id: string) {
        return {
          provider,
          id,
          name: id,
          context: { contextWindow: 128000 },
          defaultMaxTokens: 4096,
        }
      }
      async *stream(_request: GenerateOptions): AsyncIterable<StreamChunk> {
        requests++
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'text', text: 'Verified toggle continuation.' },
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['fixture'], new Model())
    const agent = await ctx.agentLoop.create(
      SessionId('toggle'),
      { provider: 'fixture', model: 'model' },
      { cwd: dir },
    )
    const follow = async () => {
      agent.followup(
        createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'Continue without publication.' }],
        }),
      )
      await agent.whenIdle()
    }
    const runtime = ctx.compaction
    await follow()
    expect(native).toHaveBeenCalled()
    expect(runtime).toBeInstanceOf(EvidenceCompactionEngine)
    const enable = () =>
      ctx.plugin({
        inject: EvidenceCompactorManager.inject,
        apply(scope: Context) {
          new EvidenceCompactorManager(
            scope,
            BaseConfig({
              dataDir: join(dir, 'archive'),
              installOnEnable: false,
              archiveEnabled: false,
            }) as Config,
            {
              workerUrl: new URL('../../../support/evidence-store/lib/worker.js', import.meta.url),
            },
          )
        },
      })
    let owner = enable()
    await owner.await()
    const manager = ctx.evidenceCompactor
    expect(ctx.compaction).toBeInstanceOf(EvidenceCompactionEngine)
    await follow()
    expect(manager.view().sessions).toBe(1)
    native.mockClear()
    await owner.dispose()
    expect(ctx.get('evidenceCompactor')).toBeUndefined()
    await follow()
    expect(native).toHaveBeenCalled()
    expect(ctx.compaction).toBeInstanceOf(EvidenceCompactionEngine)
    const compacted = await runtime.compactNow(agent, new AbortController().signal)
    expect(compacted?.shadowedSeqs.length).toBeGreaterThan(0)
    expect(
      agent.session.snapshotEvents().some((event) => event.type === 'compaction/summary'),
    ).toBe(true)
    expect(manual).toHaveBeenCalledOnce()
    owner = enable()
    await owner.await()
    await follow()
    expect(ctx.evidenceCompactor.view().sessions).toBe(1)
    expect(requests).toBe(5)
  } finally {
    native.mockRestore()
    manual.mockRestore()
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
