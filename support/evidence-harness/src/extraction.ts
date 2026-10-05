/** DSH's native provider seam; the storage/extraction scheduler stays harness-independent. */
import type { GenerateOptions, LlmRuntime, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import type {
  EvidenceHit,
  ExtractionAdapter,
  ExtractionInput,
  ExtractionOutput,
} from '@loncothad/dsh-evidence-store'
import { EXTRACTOR_INSTRUCTION, ExtractionFailure } from '@loncothad/dsh-evidence-store'

const MAX_BYTES = 64 * 1024
const MAX_CHUNKS = 16_384

/** Only original spans and host-assigned attribution cross the extraction boundary. */
export function extractionEvidence(evidence: readonly EvidenceHit[]): string {
  if (!evidence.length || evidence.length > 8) throw new Error('Invalid extraction evidence window')
  return JSON.stringify(
    evidence.map((hit) => ({
      evidenceId: hit.id,
      eventId: hit.eventId,
      role: hit.role,
      seq: hit.seq,
      startByte: hit.startByte,
      endByte: hit.endByte,
      quote: hit.quote,
      previousId: hit.previousId,
      nextId: hit.nextId,
    })),
  )
}

/** Combine DSH text pricing with conservative UTF-8 accounting for the evidence envelope. */
export function extractionTokens(
  evidence: readonly EvidenceHit[],
  instruction = EXTRACTOR_INSTRUCTION,
): number {
  const body = extractionEvidence(evidence)
  return Math.max(
    estimateContent([{ type: 'text', text: instruction }]) +
      estimateContent([{ type: 'text', text: body }]) +
      8,
    Math.ceil(
      Buffer.byteLength(
        JSON.stringify({
          system: instruction,
          messages: [{ role: 'user', content: [{ type: 'text', text: body }] }],
          tools: [],
        }),
        'utf8',
      ) / 3,
    ),
  )
}

function usageReport(usage: TokenUsage | undefined): ExtractionOutput['report'] {
  if (!usage) return { unknownBilling: true }
  const valid = (amount: number | undefined) =>
    amount === undefined || (Number.isSafeInteger(amount) && amount >= 0)
  if (
    typeof usage.inputTokens !== 'number' ||
    typeof usage.outputTokens !== 'number' ||
    ![usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].every(
      valid,
    )
  )
    throw new Error('Invalid extraction usage')
  const inputTokens =
    usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  if (!Number.isSafeInteger(inputTokens)) throw new Error('Invalid extraction usage total')
  return {
    inputTokens,
    outputTokens: usage.outputTokens,
    unknownBilling: false,
  }
}

/** Validate a bounded native stream. Tool calls, truncation, and partial JSON cannot become memory. */
export async function extractionOutput(
  stream: AsyncIterable<StreamChunk>,
  signal: AbortSignal,
): Promise<ExtractionOutput> {
  const blocks = new Map<number, { type: string; text: string; ended: boolean; deltas: boolean }>()
  let chunks = 0,
    bytes = 0,
    complete = false
  let usage: TokenUsage | undefined
  for await (const chunk of stream) {
    signal.throwIfAborted()
    if (++chunks > MAX_CHUNKS || complete) throw new Error('Invalid extraction stream')
    if (chunk.type === 'usage') {
      usage = chunk.usage
      continue
    }
    if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error')
        throw new ExtractionFailure(
          chunk.reason.failure.status === 429 || (chunk.reason.failure.status ?? 0) >= 500,
          chunk.reason.failure.status,
        )
      if (chunk.reason.kind !== 'stop') throw new Error('Extraction did not finish successfully')
      if ([...blocks.values()].some((block) => !block.ended))
        throw new Error('Extraction has unfinished blocks')
      complete = true
      continue
    }
    if (chunk.type === 'tool-call-delta') throw new Error('Extraction returned a tool call')
    if (chunk.type === 'block-start') {
      if (
        !Number.isSafeInteger(chunk.index) ||
        chunk.index < 0 ||
        blocks.has(chunk.index) ||
        blocks.size >= 16 ||
        !['text', 'reasoning'].includes(chunk.blockType)
      )
        throw new Error('Invalid extraction block')
      blocks.set(chunk.index, { type: chunk.blockType, text: '', ended: false, deltas: false })
      continue
    }
    const block = blocks.get(chunk.index)
    if (!block || block.ended) throw new Error('Invalid extraction block order')
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      if (block.type !== (chunk.type === 'text-delta' ? 'text' : 'reasoning'))
        throw new Error('Invalid extraction delta')
      bytes += Buffer.byteLength(chunk.text, 'utf8')
      if (bytes > MAX_BYTES) throw new Error('Extraction output is oversized')
      block.text += chunk.text
      block.deltas = true
    } else if (chunk.type === 'block-end') {
      if (
        (chunk.block.type !== 'text' && chunk.block.type !== 'reasoning') ||
        chunk.block.type !== block.type ||
        (block.deltas && chunk.block.text !== block.text)
      )
        throw new Error('Invalid extraction block closure')
      if (!block.deltas) {
        bytes += Buffer.byteLength(chunk.block.text, 'utf8')
        if (bytes > MAX_BYTES) throw new Error('Extraction output is oversized')
        block.text = chunk.block.text
      }
      block.ended = true
    }
  }
  if (!complete) throw new Error('Extraction has no successful terminal record')
  const report = usageReport(usage)
  if ((report.outputTokens ?? 0) > 1500) throw new Error('Extraction exceeded its output cap')
  const payload = [...blocks.values()]
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  if (!payload.trim()) throw new Error('Extraction returned no JSON')
  return { payload, report }
}

export interface NativeExtractionOptions {
  /** Explicit operator capacity, used only when this extraction route advertises none. */
  fallbackContextWindow?: number
  /** Framing and estimation headroom, in addition to the fixed output reservation. */
  safetyTokens?: number
  /** Required host policy/source recheck, run again after asynchronous model resolution. */
  authorize(input: ExtractionInput, signal: AbortSignal): Promise<void>
}

export class NativeExtractionAdapter implements ExtractionAdapter {
  constructor(
    private readonly llm: Pick<LlmRuntime, 'prepareCall'>,
    private readonly options: NativeExtractionOptions,
  ) {}
  count(evidence: readonly EvidenceHit[]): number {
    return extractionTokens(evidence)
  }
  async run(input: ExtractionInput, signal: AbortSignal): Promise<ExtractionOutput> {
    signal.throwIfAborted()
    if (
      input.tools.length ||
      input.maxOutputTokens !== 1500 ||
      input.instruction !== EXTRACTOR_INSTRUCTION ||
      !input.provider ||
      !input.model
    )
      throw new Error('Invalid native extraction request')
    await this.options.authorize(input, signal)
    const prepared = await this.llm.prepareCall(
      { provider: input.provider, model: input.model, maxTokens: 1500 },
      signal,
    )
    if (
      prepared.config.provider !== input.provider ||
      prepared.config.model !== input.model ||
      prepared.config.maxTokens !== 1500
    )
      throw new Error('Extraction route or cap changed during preparation')
    const tokens = extractionTokens(input.evidence, input.instruction)
    if (tokens > 8000) throw new Error('Extraction evidence exceeds its input capacity')
    const request: GenerateOptions = {
      ...prepared.config,
      system: input.instruction,
      messages: [
        { role: 'user', content: [{ type: 'text', text: extractionEvidence(input.evidence) }] },
      ],
      tools: [],
      purpose: 'compaction',
      signal,
    }
    const contextWindow = prepared.context?.contextWindow ?? this.options.fallbackContextWindow
    const safety = this.options.safetyTokens ?? 512
    if (contextWindow === undefined)
      throw new Error(
        'Extraction model advertises no context capacity; configure an explicit extraction fallback',
      )
    if (
      !Number.isSafeInteger(contextWindow) ||
      contextWindow < 1 ||
      !Number.isSafeInteger(safety) ||
      safety < 0
    )
      throw new Error('Invalid extraction capacity or safety reservation')
    const { signal: _signal, ...envelope } = request
    const requestTokens = Math.max(
      tokens,
      Math.ceil(Buffer.byteLength(JSON.stringify(envelope), 'utf8') / 3),
    )
    if (requestTokens > 9000 || requestTokens + 1500 + safety > contextWindow)
      throw new Error('Extraction model has insufficient input capacity')
    await this.options.authorize(input, signal)
    signal.throwIfAborted()
    return extractionOutput(prepared.stream(request), signal)
  }
}
