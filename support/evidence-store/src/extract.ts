/** Bounded incremental extraction. Request assembly never awaits this scheduler. */

import type { EvidenceStore } from './index.ts'
import { EXTRACTOR_INSTRUCTION, EXTRACTOR_INSTRUCTION_HASH, EXTRACTOR_VERSION } from './memory.ts'
import type { EvidenceHit, ExtractionJob, JobReport, Scope } from './types.ts'

export interface ExtractionInput {
  provider: string
  model: string
  instruction: string
  evidence: readonly EvidenceHit[]
  maxOutputTokens: 1500
  tools: readonly []
}
export interface ExtractionOutput {
  payload: unknown
  report: JobReport
  toolCalls?: boolean
}
export interface ExtractionAdapter {
  /** Count original evidence as it will be serialized for this configured model. */
  count(evidence: readonly EvidenceHit[]): number | Promise<number>
  run(input: ExtractionInput, signal: AbortSignal): Promise<ExtractionOutput>
}
export class ExtractionFailure extends Error {
  constructor(
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(status ? `Extraction failed (HTTP ${status})` : 'Extraction failed')
  }
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup()
      reject(signal.reason)
    }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    operation.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}

export class EvidenceExtractor {
  private operation: Promise<void> | undefined
  constructor(
    private readonly store: EvidenceStore,
    private readonly scope: Scope,
    private readonly adapter: ExtractionAdapter,
  ) {}

  /** One extraction at a time; persisted jobs own source coverage and the retry ceiling. */
  maintain(
    signal: AbortSignal,
    options: { threshold?: number; timeoutMs?: number } = {},
  ): Promise<void> {
    if (this.operation) return this.operation
    const threshold = options.threshold ?? 4000
    const timeoutMs = options.timeoutMs ?? 60_000
    if (
      !Number.isInteger(threshold) ||
      threshold < 1 ||
      threshold > 8000 ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 300_000
    )
      return Promise.reject(new Error('Invalid extraction limits'))
    this.operation = this.work(signal, threshold, timeoutMs).finally(() => {
      this.operation = undefined
    })
    return this.operation
  }
  private async work(signal: AbortSignal, threshold: number, timeoutMs: number): Promise<void> {
    signal.throwIfAborted()
    let job = await this.store.claim(this.scope)
    if (!job) {
      const pending = await this.store.pendingEvidence(this.scope)
      const selected: EvidenceHit[] = []
      let tokens = 0
      for (const source of pending) {
        const candidate = [...selected, source]
        const counted = await this.adapter.count(candidate)
        if (!Number.isSafeInteger(counted) || counted < 0)
          throw new Error('Invalid extraction token count')
        if (counted > 8000) break
        selected.push(source)
        tokens = counted
      }
      if (tokens < threshold || !selected.length) return
      await this.store.enqueue(
        this.scope,
        selected.map((source) => source.id),
        tokens,
      )
      job = await this.store.claim(this.scope)
      if (!job) return
    }
    await this.run(job, signal, timeoutMs)
  }
  private async run(job: ExtractionJob, signal: AbortSignal, timeoutMs: number): Promise<void> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    let report: JobReport = { unknownBilling: true }
    try {
      if (
        job.instructionHash !== EXTRACTOR_INSTRUCTION_HASH ||
        job.extractorVersion !== EXTRACTOR_VERSION
      )
        throw new Error('Extraction job uses an unsupported extractor version')
      const evidence = await this.store.read(this.scope, job.evidenceIds)
      const state = await this.store.state(this.scope)
      if (
        evidence.length !== job.evidenceIds.length ||
        state.policyRevision !== job.state.policyRevision ||
        state.controlRevision !== job.state.controlRevision
      )
        throw new Error('Stale extraction input')
      const count = await this.adapter.count(evidence)
      if (!Number.isSafeInteger(count) || count < 1 || count > 8000)
        throw new Error('Extraction input exceeds its token budget')
      deadline.throwIfAborted()
      const result = await abortable(
        this.adapter.run(
          {
            provider: job.provider,
            model: job.model,
            instruction: EXTRACTOR_INSTRUCTION,
            evidence,
            maxOutputTokens: 1500,
            tools: [],
          },
          deadline,
        ),
        deadline,
      )
      report = result.report
      if (result.toolCalls) throw new Error('Extraction returned action tools')
      if (report.outputTokens !== undefined && report.outputTokens > 1500)
        throw new Error('Extraction output exceeds its budget')
      const payload =
        typeof result.payload === 'string'
          ? result.payload.length <= 64 * 1024
            ? (JSON.parse(result.payload) as unknown)
            : (() => {
                throw new Error('Extraction response is oversized')
              })()
          : result.payload
      await this.store.publish(this.scope, job, payload, report)
    } catch (error) {
      // Do not persist arbitrary provider messages: they may contain credentials or source data.
      await this.store.gap(
        this.scope,
        job,
        {
          ...report,
          gap: deadline.aborted
            ? 'Extraction cancelled or timed out'
            : 'Extraction failed validation or transport',
        },
        error instanceof ExtractionFailure && error.retryable && !deadline.aborted,
      )
      if (signal.aborted) signal.throwIfAborted()
    }
  }
}
