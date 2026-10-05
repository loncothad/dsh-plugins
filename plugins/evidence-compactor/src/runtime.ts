/** The public native compaction backend mounted in isolated agent presets. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type {
  CompactionAgentContext,
  CompactionResult,
  CompactionTrigger,
  ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import {
  type BasicCompactionConfig,
  BasicCompactionEngine,
} from '@deepseek-ai/dsh-compaction-basic'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CONTEXT_WINDOW_EXCEEDED_CODE, isAgentLoopRequest, LlmError } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { ContextOverflow } from '@loncothad/dsh-evidence-store'
import type {} from './manager.ts'
import { requestBudget, requestTokens } from './measurement.ts'

export default class EvidenceCompactionEngine extends BasicCompactionEngine {
  static inject = ['llm', 'sessions', 'sessionQuery', 'tokenMeter']
  private readonly requests = new WeakMap<Session, GenerateOptions>()
  private readonly retries = new WeakMap<Session, number>()
  private readonly rebuilding = new WeakMap<Session, number>()
  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx, config)
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      const manager = ctx.get('evidenceCompactor')
      if (!manager) return decision
      const message = await manager.run(agent.session, (ledger) => ledger.pinMessage())
      return message ? { ...decision, messages: [message, ...decision.messages] } : decision
    })
    ctx.on('llm/stream', (options, next) => this.guard(options, next))
    ctx.on(
      'agent/request-error',
      async ({ agent, failure, signal }, next) => {
        if (
          !ctx.get('evidenceCompactor') ||
          failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE ||
          signal.aborted ||
          (this.retries.get(agent.session) ?? 0) >= 8
        )
          return next()
        const rebuiltFrom = this.rebuilding.get(agent.session)
        this.rebuilding.delete(agent.session)
        if (rebuiltFrom !== undefined && agent.session.surface.replaceGeneration > rebuiltFrom) {
          this.retries.set(agent.session, (this.retries.get(agent.session) ?? 0) + 1)
          return { kind: 'retry' }
        }
        const generation = agent.session.surface.replaceGeneration
        const result = await this.compactIfNeeded(agent, 'context-overflow', signal)
        if (!result || agent.session.surface.replaceGeneration <= generation) return next()
        this.retries.set(agent.session, (this.retries.get(agent.session) ?? 0) + 1)
        return { kind: 'retry' }
      },
      { prepend: true },
    )
    ctx.on('session/event', (session, event) => {
      if (event.type === 'assistant/message' || event.type === 'turn/end') {
        this.retries.delete(session)
        this.rebuilding.delete(session)
      }
    })
  }
  private async *guard(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const manager = this.ctx.get('evidenceCompactor')
    if (!manager || !isAgentLoopRequest(options)) {
      yield* next()
      return
    }
    if (!options.sessionId) throw new Error('A loop-built evidence request has no session identity')
    const session = this.ctx.sessions.get(options.sessionId)
    if (!session) throw new Error('The native evidence session is unavailable')
    this.requests.set(session, options)
    const signal = options.signal ?? new AbortController().signal
    signal.throwIfAborted()
    for (const message of options.messages)
      for (const block of message.content) {
        if (
          block.type === 'image' &&
          !block.offloaded &&
          !this.ctx.llm.imageRequestPricing(options.provider, options.model)
        )
          throw new LlmError(
            'This route supplies no native image-token accounting; evidence compaction cannot safely admit its image context',
            'UNSUPPORTED_EVIDENCE_MODALITY',
          )
      }
    let rebuilding = false
    try {
      await manager.run(session, async (ledger) => {
        await ledger.refresh()
        const beforeRecovery = session.surface.replaceGeneration
        if (await ledger.recoverDeleted()) {
          this.rebuilding.set(session, beforeRecovery)
          rebuilding = true
          return
        }
        const { budget } = requestBudget(session, options, manager.config)
        const measurement = this.ctx.tokenMeter.measure(session)
        const tokens = requestTokens(options, measurement.totalTokens)
        if (tokens > budget.trigger) {
          const generation = session.surface.replaceGeneration
          if (
            await ledger.maskObservations(
              options,
              AbortSignal.any([signal, manager.signal, ledger.lifetime.signal]),
            )
          ) {
            this.rebuilding.set(session, generation)
            rebuilding = true
            return
          }
          const result = await ledger.compact(
            options,
            'automatic',
            AbortSignal.any([signal, manager.signal, ledger.lifetime.signal]),
          )
          if (result) {
            this.rebuilding.set(session, generation)
            rebuilding = true
            return
          }
          if (tokens > budget.workingInput) throw new ContextOverflow(tokens, budget.workingInput)
        }
        await ledger.record(options, tokens)
      })
    } catch (error) {
      if (error instanceof ContextOverflow) throw new LlmError(error.message, error.code)
      throw error
    }
    if (rebuilding) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: CONTEXT_WINDOW_EXCEEDED_CODE,
            message: 'Evidence context selection requires a native request rebuild',
          },
        },
      }
      return
    }
    signal.throwIfAborted()
    manager.signal.throwIfAborted()
    yield* next()
  }
  private request(agent: CompactionAgentContext): GenerateOptions | undefined {
    const captured = this.requests.get(agent.session)
    const header = agent.session.requestHeader()
    if (!header) return captured
    return {
      ...header.config,
      messages: agent.session.deriveMessages(),
      tools: header.tools ? [...header.tools] : [],
      toolHistory: agent.session.toolHistory(),
      sessionId: agent.session.id,
    }
  }
  async compactIfNeeded(
    agent: CompactionAgentContext,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const manager = this.ctx.get('evidenceCompactor')
    if (!manager) return super.compactIfNeeded(agent as Agent, trigger, signal)
    // Evidence request admission owns automatic pressure; the inherited hook remains available when disabled.
    if (trigger === 'pressure') return null
    const request = this.request(agent)
    if (!request) return null
    return manager.run(agent.session, (ledger) =>
      ledger.compact(
        request,
        'automatic',
        AbortSignal.any([signal, manager.signal, ledger.lifetime.signal]),
        undefined,
        undefined,
        trigger === 'context-overflow',
      ),
    )
  }
  compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    const manager = this.ctx.get('evidenceCompactor')
    if (!manager) return super.compactNow(agent as Agent, signal, sourceCommandId)
    return agent.runMaintenance(async (agentSignal) => {
      const request = this.request(agent)
      if (!request) return null
      const result = await manager.run(agent.session, (ledger) =>
        ledger.compact(
          request,
          'manual',
          AbortSignal.any([signal, agentSignal, manager.signal, ledger.lifetime.signal]),
          sourceCommandId,
        ),
      )
      if (result) await this.ctx.sessions.flush(agent.session)
      return result
    })
  }
  async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: CompactionAgentContext,
    signal = new AbortController().signal,
  ): Promise<CompactionResult> {
    const manager = this.ctx.get('evidenceCompactor')
    if (!manager) return super.compactRegion(start, end, agent as Agent, signal)
    const request = this.request(agent)
    if (!request) throw new Error('The native session has no routed request to compact')
    const result = await manager.run(agent.session, (ledger) =>
      ledger.compact(
        request,
        'automatic',
        AbortSignal.any([signal, manager.signal, ledger.lifetime.signal]),
        undefined,
        { start, end },
      ),
    )
    if (!result) throw new Error('The selected compaction region provides no safe reduction')
    return result
  }
}
