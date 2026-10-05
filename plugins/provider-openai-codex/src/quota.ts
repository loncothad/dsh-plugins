import type { SubscriptionQuota } from '@loncothad/dsh-plugin-runtime'
import { quotaRecord, ResetLedger, subscriptionJson } from '@loncothad/dsh-plugin-runtime'
import type { CodexAdapter } from './adapter.ts'
import type { CodexAuthorizationStore } from './store.ts'

const optionalNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
export function parseCodexQuota(
  value: unknown,
  credits: unknown,
  observedAt: number,
): SubscriptionQuota {
  const row = quotaRecord(value),
    windows: SubscriptionQuota['windows'] = []
  const add = (value: unknown, name: string) => {
    if (!value) return
    const limit = quotaRecord(value)
    for (const [key, label] of [
      ['primary_window', 'Primary'],
      ['secondary_window', 'Secondary'],
    ]) {
      if (!limit[key]) continue
      const source = quotaRecord(limit[key]),
        next: SubscriptionQuota['windows'][number] = { label: `${name}: ${label}` }
      for (const [field, output, multiplier] of [
        ['used_percent', 'usedPercent', 1],
        ['limit_window_seconds', 'windowSeconds', 1],
        ['reset_at', 'resetsAt', 1000],
      ] as const) {
        const number = optionalNumber(source[field])
        if (number !== undefined) next[output] = number * multiplier
      }
      windows.push(next)
    }
  }
  add(row.rate_limit, 'Codex')
  if (Array.isArray(row.additional_rate_limits))
    for (const item of row.additional_rate_limits.slice(0, 64)) {
      const source = quotaRecord(item)
      add(
        source.rate_limit,
        typeof source.limit_name === 'string'
          ? source.limit_name
          : typeof source.metered_feature === 'string'
            ? source.metered_feature
            : 'Additional',
      )
    }
  const details = credits ? quotaRecord(credits) : undefined
  const resets: SubscriptionQuota['resets'] = []
  const resetHistory: NonNullable<SubscriptionQuota['resetHistory']> = []
  if (Array.isArray(details?.credits))
    for (const item of details.credits.slice(0, 128)) {
      const credit = quotaRecord(item),
        expiry = typeof credit.expires_at === 'string' ? Date.parse(credit.expires_at) : undefined
      if (typeof credit.id !== 'string') continue
      const label = typeof credit.title === 'string' ? credit.title : 'Codex usage reset'
      if (
        credit.status !== 'available' ||
        (expiry !== undefined && Number.isFinite(expiry) && expiry <= observedAt)
      )
        resetHistory.push({
          label,
          status:
            expiry !== undefined && expiry <= observedAt
              ? 'expired'
              : typeof credit.status === 'string'
                ? credit.status
                : 'unknown',
          ...(expiry !== undefined && Number.isFinite(expiry) ? { expiresAt: expiry } : {}),
        })
      if (
        credit.status !== 'available' ||
        typeof credit.id !== 'string' ||
        (expiry !== undefined && (!Number.isFinite(expiry) || expiry <= observedAt))
      )
        continue
      resets.push({
        id: credit.id,
        label: typeof credit.title === 'string' ? credit.title : 'Reset Codex usage',
        ...(expiry === undefined ? {} : { expiresAt: expiry }),
      })
    }
  return {
    observedAt,
    plan: typeof row.plan_type === 'string' ? row.plan_type : 'Unknown',
    windows,
    resets,
    resetHistory,
    resetStatus: details ? `${resets.length} available reset credits` : 'Reset credits unavailable',
  }
}
export function codexQuotaAccount(
  adapter: CodexAdapter,
  store: CodexAuthorizationStore,
  transport: typeof fetch = fetch,
) {
  const read = async (name: string, signal: AbortSignal) => {
    let account = await adapter.accountTokens(name, signal)
    const request = async (path: string, body?: unknown) => {
      const headers = {
        authorization: `Bearer ${account.tokens.accessToken}`,
        ...(account.accountId ? { 'ChatGPT-Account-Id': account.accountId } : {}),
      }
      return subscriptionJson(
        `https://chatgpt.com/backend-api/wham/${path}`,
        headers,
        signal,
        transport,
        body,
      )
    }
    let usage: unknown
    try {
      usage = await request('usage')
    } catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith('HTTP 401')) throw error
      account = await adapter.accountTokens(name, signal, true)
      usage = await request('usage')
    }
    let credits: unknown
    try {
      credits = await request('rate-limit-reset-credits')
    } catch {
      signal.throwIfAborted()
    }
    if ((await store.read(name))?.tokens.accessToken !== account.tokens.accessToken)
      throw new Error('Codex account changed during quota check. Refresh status.')
    return { account, request, view: parseCodexQuota(usage, credits, Date.now()) }
  }
  const pending = new Set<string>()
  const ledger = new ResetLedger()
  return {
    async quota(name: string, signal: AbortSignal) {
      return (await read(name, signal)).view
    },
    async resetQuota(name: string, resetId: string, requestId: string, signal: AbortSignal) {
      if (pending.has(name)) throw new Error('An account reset is already running')
      pending.add(name)
      try {
        const current = await read(name, signal)
        ledger.authorize(
          requestId,
          `${name}/${current.account.accountId ?? ''}`,
          resetId,
          current.view.resets.some((reset) => reset.id === resetId),
        )
        const result = quotaRecord(
          await current.request('rate-limit-reset-credits/consume', {
            redeem_request_id: requestId,
            credit_id: resetId,
          }),
        )
        if (
          !['reset', 'already_redeemed', 'nothing_to_reset', 'no_credit'].includes(
            String(result.code),
          )
        )
          throw new Error('Invalid reset response')
        const next = (await read(name, signal)).view
        return {
          ...next,
          notice:
            result.code === 'reset' ? 'Subscription usage reset.' : `Reset result: ${result.code}.`,
        }
      } finally {
        pending.delete(name)
      }
    },
  }
}
