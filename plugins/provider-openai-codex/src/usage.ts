import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'

const DEFAULT_CODES = ['RATE_LIMIT']

import {
  clearFacts,
  describeSnapshot,
  recordFact,
  type UsageFact,
  type UsageSnapshot,
} from './usage-snapshot.ts'

export * from './usage-snapshot.ts'

/** Wire the observer and the `/codex-usage` command. */
export function registerCodexUsage(ctx: Context, codes: readonly string[] = DEFAULT_CODES): void {
  let snapshot: UsageSnapshot = new Map()

  ctx.on('agent/request-error', ((
    payload: Parameters<import('@deepseek-ai/cordis').Events['agent/request-error']>[0],
    next?: () => Promise<unknown>,
  ) => {
    if (
      !['codex', 'codex-daybreak'].includes(payload.provider) ||
      !codes.includes(payload.failure.code)
    )
      return next?.()
    const fact: UsageFact = {
      provider: payload.provider,
      code: payload.failure.code,
      ...(payload.failure.status !== undefined ? { status: payload.failure.status } : {}),
      ...(payload.failure.providerRetryAfterMs !== undefined
        ? { retryAfterMs: payload.failure.providerRetryAfterMs }
        : {}),
      observedAt: Date.now(),
    }
    snapshot = recordFact(snapshot, fact)
    return next?.()
  }) as never)

  ctx.commands.register({
    name: 'codex-usage',
    description: 'Discard locally cached provider usage-limit facts',
    input: { hint: 'status | reset confirm' },
    handler: (invocation): CommandResult => {
      const raw = invocation.rawInput.trim()
      if (!raw || raw === 'status') return { kind: 'success', text: describeSnapshot(snapshot) }
      if (raw !== 'reset confirm') {
        return {
          kind: 'error',
          text:
            `${describeSnapshot(snapshot)}\n` +
            'This discards only locally cached facts; provider limits are untouched. ' +
            'Use /codex-usage reset confirm to clear local observations.',
        }
      }
      const { snapshot: next, cleared } = clearFacts(snapshot)
      snapshot = next
      if (cleared.length === 0) {
        return {
          kind: 'error',
          text: 'No cached usage-limit facts.',
        }
      }
      return {
        kind: 'success',
        text: `Cached usage-limit facts cleared for: ${cleared.join(', ')}.`,
      }
    },
  })
}
