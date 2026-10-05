/**
 * Usage-snapshot domain: recording provider rate-limit facts observed by
 * the plugin and rendering them. Pure domain.
 *
 * @module @loncothad/dsh-provider-openai-codex/usage-snapshot
 */

/** One observed rate-limit fact. */
export interface UsageFact {
  readonly provider: string
  /** Failure code (e.g. RATE_LIMIT). */
  readonly code: string
  /** HTTP status when the provider supplied one. */
  readonly status?: number
  /** Provider-requested delay in milliseconds, when supplied. */
  readonly retryAfterMs?: number
  /** Wall-clock epoch milliseconds of the observation. */
  readonly observedAt: number
}

/** In-memory snapshot keyed by provider. */
export type UsageSnapshot = ReadonlyMap<string, UsageFact>

/** Record one fact, keeping the latest per provider. */
export function recordFact(snapshot: UsageSnapshot, fact: UsageFact): UsageSnapshot {
  return new Map(snapshot).set(fact.provider, fact)
}

/** Clear one or all providers' facts; reports what was cleared. */
export function clearFacts(
  snapshot: UsageSnapshot,
  provider?: string,
): { snapshot: UsageSnapshot; cleared: string[] } {
  if (provider === undefined) {
    return { snapshot: new Map(), cleared: [...snapshot.keys()] }
  }
  if (!snapshot.has(provider)) return { snapshot, cleared: [] }
  const next = new Map(snapshot)
  next.delete(provider)
  return { snapshot: next, cleared: [provider] }
}

/** Render one fact's retry delay in friendly units. */
export function describeDelay(retryAfterMs: number | undefined): string {
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0)
    return 'unknown'
  const seconds = Math.round(retryAfterMs / 100) / 10
  if (seconds < 90) return `${seconds}s`
  return `${Math.round(seconds / 60)}min`
}

/** Render the whole snapshot as command output. */
export function describeSnapshot(snapshot: UsageSnapshot): string {
  if (snapshot.size === 0) return 'No provider usage-limit facts are cached.'
  return [...snapshot.values()]
    .map(
      (fact) =>
        `${fact.provider}: ${fact.code}${fact.status !== undefined ? ` (HTTP ${fact.status})` : ''}` +
        `; provider-requested retry after ${describeDelay(fact.retryAfterMs)}`,
    )
    .join('\n')
}
