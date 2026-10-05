/**
 * Configurable retry policy domain: attempt budget, exponential backoff
 * with symmetric jitter, and retryability classification, aligned with the
 * harness's `ResolvedRetryPolicy` shape. Pure domain: time and randomness
 * are injected.
 *
 * @module @loncothad/dsh-fallback-router/backoff
 */

/** One tunable policy, resolved from plugin config. */
export interface TunableRetryPolicy {
  readonly maxRetries: number
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
  readonly retryableCodes: readonly string[]
}

/** Failure facts the classification reads (a subset of `LlmFailure`). */
export interface FailureLike {
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
}

/** The harness's stock defaults, used when tuning is disabled. */
export const STOCK_POLICY: Readonly<TunableRetryPolicy> = Object.freeze({
  maxRetries: 5,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
})

/** Clamp one config-shaped policy into a usable one. */
export function resolvePolicy(config: Partial<TunableRetryPolicy>): TunableRetryPolicy {
  return {
    maxRetries: clamp(config.maxRetries ?? STOCK_POLICY.maxRetries, 0, 100),
    initialDelayMs: clamp(config.initialDelayMs ?? STOCK_POLICY.initialDelayMs, 0, 2_147_000_000),
    maxDelayMs: clamp(config.maxDelayMs ?? STOCK_POLICY.maxDelayMs, 1, 2_147_000_000),
    jitterRatio: clamp(config.jitterRatio ?? STOCK_POLICY.jitterRatio, 0, 1),
    retryableCodes: config.retryableCodes ?? STOCK_POLICY.retryableCodes,
  }
}

/** Whether one failure is retryable under one policy. */
export function isRetryable(policy: TunableRetryPolicy, failure: FailureLike): boolean {
  return policy.retryableCodes.includes(failure.code)
}

/**
 * The delay before retry number `retry` (one-based): exponential from
 * `initialDelayMs`, capped at `maxDelayMs`, displaced by symmetric jitter,
 * then capped again. A provider-requested delay wins when it fits.
 */
export function delayFor(
  policy: TunableRetryPolicy,
  retry: number,
  failure: FailureLike,
  random: () => number = Math.random,
): number {
  const requested = failure.providerRetryAfterMs
  if (requested !== undefined && Number.isFinite(requested) && requested > 0) {
    if (requested <= policy.maxDelayMs) return requested
    if (policy.maxRetries === 0) return 0
  }
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs)
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random()
  return Math.min(Math.round(exponential * jitter), policy.maxDelayMs)
}

/** Whether the budget allows one more retry after `retriesSoFar` attempts. */
export function withinBudget(policy: TunableRetryPolicy, retriesSoFar: number): boolean {
  return retriesSoFar < policy.maxRetries
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(Math.max(value, minimum), maximum)
}
