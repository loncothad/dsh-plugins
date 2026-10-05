import { abortable, editableConfig, managedApply } from '@loncothad/dsh-plugin-runtime'
/**
 * Recovery routing for model requests: the tunable retry policy (an
 * `agent/request-error` waterfall listener ahead of the stock executor)
 * plus model fallback chains — when a route keeps failing with a
 * fallback-eligible code, the next route in its chain is proposed through
 * the `agent/request` waterfall on the retry the error listener grants.
 * Chains are per agent and per turn; a new turn starts from the primary
 * again. Disabled or out-of-policy failures defer to `next()`, so the
 * stock `llm-retry` executor keeps its role.
 *
 * @module @loncothad/dsh-fallback-router
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import {
  delayFor,
  isRetryable,
  resolvePolicy,
  type TunableRetryPolicy,
  withinBudget,
} from './backoff.ts'
import { DEFAULT_FALLBACK_CODES, fallbackEligible, parseChains } from './chains.ts'

export * from './backoff.ts'
export * from './chains.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fallback-router'

/** The agent loop events this plugin joins. */
export const inject = ['agents']

/** Plugin config. */
export interface Config {
  /** Master switch; false defers every failure to the stock executor. */
  enabled: Volatile<boolean>
  maxRetries: Volatile<number>
  initialDelayMs: Volatile<number>
  maxDelayMs: Volatile<number>
  jitterRatio: Volatile<number>
  retryableCodes: Volatile<string[]>
  /**
   * Fallback chains, each `"provider/model > provider/model [=effort]…"`;
   * the first route is the primary pattern (model `*` matches the whole
   * provider), the rest are taken in order on fallback-eligible failures.
   */
  chains: Volatile<string[]>
  /** Failure codes that advance a chain instead of retrying the same model. */
  fallbackCodes: Volatile<string[]>
}

const BaseConfig = z.object({
  enabled: z.boolean().default(true).volatile(),
  maxRetries: z.number().step(1).min(0).max(100).volatile(),
  initialDelayMs: z.number().min(0).max(900000).volatile(),
  maxDelayMs: z.number().min(1).max(900000).volatile(),
  jitterRatio: z.number().min(0).max(1).volatile(),
  retryableCodes: z.array(z.string()).volatile(),
  chains: z
    .array(z.string())
    .max(64)
    .default([])
    .description(
      'Ordered primary and fallback routes. Configure them with the model pickers below.',
    )
    .volatile(),
  fallbackCodes: z
    .array(z.string())
    .default([...DEFAULT_FALLBACK_CODES])
    .volatile(),
})

/** Read access to the materialized settings. */
export interface PolicyAccess {
  policy(): TunableRetryPolicy
  enabled(): boolean
  chains(): readonly import('./chains.ts').FallbackChain[]
  fallbackCodes(): readonly string[]
}

/** Deterministic hooks for tests. */
export interface FallbackRouterInternals {
  /** Jitter sample in [0, 1]. */
  random?: () => number
  /** Sleep stub; receives the computed delay in milliseconds. */
  sleep?: (delayMs: number) => Promise<void>
}

/** The agent loop's request-error payload, typed through the event map. */
type RequestErrorPayload = Parameters<
  import('@deepseek-ai/cordis').Events['agent/request-error']
>[0]
type RequestErrorAction =
  ReturnType<RequestErrorPayload extends never ? never : () => unknown> extends never
    ? never
    : { kind: string }
type RequestPayload = Parameters<import('@deepseek-ai/cordis').Events['agent/request']>[0]

/**
 * Register the recovery listeners. The error listener owns recovery for
 * fallback-eligible failures with a next chain route (no backoff sleep —
 * the next route is a different resource) and for in-policy retries of
 * everything else; the request listener rewrites the proposal to the
 * pending fallback route.
 */
export function registerFallbackRouter(
  ctx: Context,
  access: PolicyAccess,
  internals: FallbackRouterInternals = {},
): void {
  const random = internals.random ?? Math.random
  const lifetime = new AbortController()
  ctx.effect(
    () => () => lifetime.abort(new Error('Fallback configuration replaced')),
    'fallback: cancel pending delays',
  )
  const sleep = async (delayMs: number, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (internals.sleep) return abortable(internals.sleep(delayMs), signal)
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', stop)
        reject(signal.reason)
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', stop)
        resolve()
      }, delayMs)
      signal.addEventListener('abort', stop, { once: true })
    })
  }
  // Per-provider retry counts, reset when the conversation turn advances —
  // the same reset the stock executor performs through its session
  // projection. Without it, a long session would exhaust the budget after
  // `maxRetries` total historical failures.
  const attempts = new Map<string, number>()
  const turns = new Map<string, number>()
  // Pending fallback per agent: how many chain routes were consumed this
  // turn and which chain owns the recovery. Cleared when the turn
  // advances or the chain is exhausted. The last proposed route rides
  // along because request-error carries only the provider.
  const consumed = new Map<
    string,
    { turn: number; count: number; chain: import('./chains.ts').FallbackChain }
  >()
  const lastRoute = new Map<string, { turn: number; provider: string; model: string }>()

  ctx.on('agent/disposed', ({ agent }) => {
    const id = String(agent.id)
    consumed.delete(id)
    lastRoute.delete(id)
    for (const key of attempts.keys())
      if (key.startsWith(`${id}/`)) {
        attempts.delete(key)
        turns.delete(key)
      }
  })
  ctx.effect(
    () => () => {
      attempts.clear()
      turns.clear()
      consumed.clear()
      lastRoute.clear()
    },
    'fallback: release per-agent recovery state',
  )
  ctx.on('agent/request-error', ((
    payload: RequestErrorPayload,
    next: () => Promise<RequestErrorAction | undefined>,
  ) => {
    if (!access.enabled()) return next()
    const agentId = String((payload as { agent?: { id?: unknown } }).agent?.id ?? payload.provider)
    const turn = (payload as { turn?: number }).turn ?? 0

    // Fallback first: a different route for a dead model beats sleeping
    // on the same one.
    const chains = access.chains()
    if (chains.length > 0 && fallbackEligible(access.fallbackCodes(), payload.failure)) {
      const pending = consumed.get(agentId)
      const seen = lastRoute.get(agentId)
      const failed =
        seen !== undefined && seen.turn === turn
          ? { provider: seen.provider, model: seen.model }
          : { provider: payload.provider, model: '*' }
      // The chain is chosen by the failing route and stays fixed for the
      // turn: after a fallback, the loop's own request header re-seeds
      // from the last-used model, so the chain must not be re-matched.
      const chain =
        pending !== undefined && pending.turn === turn
          ? pending.chain
          : chains.find(
              (candidate) =>
                candidate.primary.provider === failed.provider &&
                (candidate.primary.model === '*' || candidate.primary.model === failed.model),
            )
      const used = pending !== undefined && pending.turn === turn ? pending.count : 0
      const route = chain?.fallbacks[used]
      if (chain !== undefined && route !== undefined) {
        consumed.set(agentId, { turn, count: used + 1, chain })
        return Promise.resolve({ kind: 'retry' as const })
      }
      consumed.delete(agentId)
    }

    const policy = access.policy()
    if (!isRetryable(policy, payload.failure)) return next()
    const key = `${agentId}/${payload.provider}`
    if ((turns.get(key) ?? -1) !== turn) {
      turns.set(key, turn)
      attempts.delete(key)
    }
    const retriesSoFar = attempts.get(key) ?? 0
    if (!withinBudget(policy, retriesSoFar)) {
      attempts.delete(key)
      return next()
    }
    attempts.set(key, retriesSoFar + 1)
    const delay = delayFor(policy, retriesSoFar + 1, payload.failure, random)
    return sleep(
      delay,
      AbortSignal.any([
        lifetime.signal,
        (payload as { signal?: AbortSignal }).signal ?? new AbortController().signal,
      ]),
    ).then(() => ({ kind: 'retry' as const }))
  }) as never)

  ctx.on('agent/request', ((payload: RequestPayload, next: () => Promise<LlmCallConfig>) => {
    const agentId = String(payload.agent.id)
    return next().then((config) => {
      const remember = (value: LlmCallConfig) => {
        lastRoute.set(agentId, { turn: payload.turn, provider: value.provider, model: value.model })
        return value
      }
      if (!access.enabled()) return remember(config)
      const pending = consumed.get(agentId)
      if (pending === undefined || pending.turn !== payload.turn) return remember(config)
      // Rewrite to the pending chain route unconditionally: the loop's
      // own header continuation re-seeds from the last-used model, which
      // is exactly the route that just failed.
      const route = pending.chain.fallbacks[pending.count - 1]
      if (route === undefined) return remember(config)
      return remember({
        ...config,
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort !== undefined
          ? { reasoningEffort: route.reasoningEffort as never }
          : {}),
      })
    })
  }) as never)
}

/** Register with the materialized volatile settings. */
function activate(ctx: Context, config: Config, internals: FallbackRouterInternals = {}): void {
  registerFallbackRouter(
    ctx,
    {
      policy: () =>
        resolvePolicy({
          maxRetries: config.maxRetries.get(),
          initialDelayMs: config.initialDelayMs.get(),
          maxDelayMs: config.maxDelayMs.get(),
          jitterRatio: config.jitterRatio.get(),
          retryableCodes: config.retryableCodes.get(),
        }),
      enabled: () => config.enabled.get(),
      chains: () => parseChains(config.chains.get()),
      fallbackCodes: () => config.fallbackCodes.get(),
    },
    internals,
  )
}

/** Complete configuration and managed capability lifetime. */
export const Config = editableConfig(BaseConfig)
export const apply = managedApply(BaseConfig, activate)
