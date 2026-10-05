/**
 * Fallback-chain domain: parsing `"provider/model > provider/model"` route
 * chains and matching the route that failed. Pure domain.
 *
 * A chain's first route is the primary pattern — matching provider with
 * model or `*` — and the rest are the ordered fallbacks taken when a
 * request on the primary fails with a fallback-eligible code. Models may
 * contain slashes (`openrouter/openai/gpt-4o`), so a route splits on the
 * first `/` only.
 *
 * @module @loncothad/dsh-fallback-router/chains
 */

/** Codes that make a model worth replacing rather than retrying. */
export const DEFAULT_FALLBACK_CODES = ['RATE_LIMIT', 'SERVER', 'AUTH'] as const

/** One resolved route in a chain. */
export interface FallbackRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One parsed fallback chain. */
export interface FallbackChain {
  /** The primary pattern (model `*` matches the whole provider). */
  readonly primary: FallbackRoute
  /** The ordered fallbacks after the primary. */
  readonly fallbacks: readonly FallbackRoute[]
}

/** Parse one `"provider/model[=effort] > …"` chain; throws on malformed input. */
export function parseChain(spec: string): FallbackChain {
  const parts = spec
    .split('>')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length < 2) {
    throw new Error(
      `a fallback chain needs a primary and at least one fallback: ${JSON.stringify(spec)}`,
    )
  }
  const routes = parts.map(parseRoute)
  return { primary: routes[0]!, fallbacks: routes.slice(1) }
}

/** Parse every non-empty chain spec. */
export function parseChains(specs: readonly string[]): readonly FallbackChain[] {
  return specs
    .map((spec) => spec.trim())
    .filter((spec) => spec.length > 0)
    .map(parseChain)
}

/** Parse one `provider/model` or `provider/model=effort` route. */
function parseRoute(part: string): FallbackRoute {
  const [route, effort] = part.split('=')
  const providerModel = route!.trim()
  const slash = providerModel.indexOf('/')
  if (slash <= 0 || slash === providerModel.length - 1) {
    throw new Error(
      `a fallback route is provider/model (model may be * or contain slashes): ${JSON.stringify(part)}`,
    )
  }
  return {
    provider: providerModel.slice(0, slash),
    model: providerModel.slice(slash + 1),
    ...(effort !== undefined && effort.length > 0 ? { reasoningEffort: effort.trim() } : {}),
  }
}

/** Whether one route matches a chain primary (`*` matches any model). */
function matches(primary: FallbackRoute, route: { provider: string; model: string }): boolean {
  return (
    primary.provider === route.provider && (primary.model === '*' || primary.model === route.model)
  )
}

/**
 * The next fallback for one failed route, given how many fallbacks were
 * already consumed on this turn: the chain's next unconsumed route, or
 * undefined when no chain matches or the chain is exhausted.
 */
export function nextFallback(
  chains: readonly FallbackChain[],
  failed: { provider: string; model: string },
  consumed: number,
): FallbackRoute | undefined {
  const chain = chains.find((candidate) => matches(candidate.primary, failed))
  if (chain === undefined) return undefined
  return chain.fallbacks[consumed] ?? undefined
}

/** Whether one failure code should advance a chain instead of retrying. */
export function fallbackEligible(codes: readonly string[], failure: { code?: string }): boolean {
  return failure.code !== undefined && codes.includes(failure.code)
}
