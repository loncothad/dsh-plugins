/** Budget the complete native envelope and the SDK's route-aware surface price. */
import { createHash } from 'node:crypto'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { InputBudget, WorkingBudget } from '@loncothad/dsh-evidence-store'
import { workingBudget } from '@loncothad/dsh-evidence-store'
import type { Config } from './config.ts'

export function requestBody(request: GenerateOptions): string {
  const { signal: _signal, messages, ...envelope } = request
  return JSON.stringify({
    ...envelope,
    messages: messages.map((message) => {
      const { id: _id, ...body } = message
      if ('source' in body && body.source?.kind === 'compact-checkpoint')
        return { ...body, source: { kind: 'compact-checkpoint' } }
      return body
    }),
  })
}
export function requestHash(request: GenerateOptions): string {
  return createHash('sha256').update(requestBody(request)).digest('hex')
}
/** UTF-8 envelope accounting complements native modality pricing; this is a conservative heuristic, not exact tokenization. */
export function envelopeTokens(request: GenerateOptions): number {
  return Math.ceil(Buffer.byteLength(requestBody(request), 'utf8') / 3)
}
export function requestTokens(request: GenerateOptions, nativeTokens: number): number {
  return Math.max(envelopeTokens(request), Math.ceil(nativeTokens))
}

export function requestBudget(
  session: Session,
  request: GenerateOptions,
  config: Config,
): { limits: InputBudget; budget: WorkingBudget } {
  const context = session.requestContext()
  if (context?.provider !== request.provider || context.model !== request.model)
    throw new Error('The native request has no matching model context observation')
  const contextWindow = context.contextWindow ?? config.fallbackContextWindow
  if (!contextWindow)
    throw new Error(
      'The selected model advertises no context window; configure an explicit fallback before compaction',
    )
  const limits: InputBudget = {
    contextWindow,
    providerMaxInput: config.providerMaxInput,
    outputReserve: request.maxTokens ?? config.outputReserve,
    safety: config.safetyTokens,
    nextToolResultReserve: config.toolResultReserve,
  }
  return { limits, budget: workingBudget(limits) }
}

/** Retained native nodes keep their route-owned image/file costs when planning a replacement. */
export function projectedTokens(
  request: GenerateOptions,
  retainedSeqs: ReadonlySet<number>,
  measurement: TokenMeasurement,
  addedTextTokens: number,
): number {
  const removed = measurement.nodes
    .filter((node) => !retainedSeqs.has(node.seq))
    .reduce((sum, node) => sum + node.tokens, 0)
  return requestTokens(request, Math.max(0, measurement.totalTokens - removed) + addedTextTokens)
}
