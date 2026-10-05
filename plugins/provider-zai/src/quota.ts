import {
  quotaRecord,
  ResetLedger,
  type SubscriptionQuota,
  subscriptionJson,
} from '@loncothad/dsh-plugin-runtime'
import type { ZaiStore } from './store.ts'

function data(value: unknown): unknown {
  const row = quotaRecord(value)
  if (row.success === false || (row.code !== undefined && row.code !== 0 && row.code !== 200))
    throw new Error('Z.AI subscription request was rejected')
  return row.data
}
export function parseZaiQuota(
  value: unknown,
  subscription: unknown,
  resets: unknown,
  observedAt: number,
): SubscriptionQuota {
  const source = quotaRecord(data(value)),
    windows: SubscriptionQuota['windows'] = []
  if (Array.isArray(source.limits))
    for (const value of source.limits.slice(0, 128)) {
      const row = quotaRecord(value)
      if (typeof row.type !== 'string') continue
      const next: SubscriptionQuota['windows'][number] = { label: row.type }
      for (const [field, output] of [
        ['percentage', 'usedPercent'],
        ['usage', 'used'],
        ['currentValue', 'used'],
        ['remaining', 'remaining'],
        ['number', 'limit'],
        ['nextResetTime', 'resetsAt'],
      ] as const) {
        const value = row[field]
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) next[output] = value
      }
      windows.push(next)
    }
  let plan = typeof source.level === 'string' ? source.level : 'Unknown'
  if (subscription) {
    const list = data(subscription)
    if (Array.isArray(list))
      for (const item of list) {
        const row = quotaRecord(item)
        if (
          row.status === 'VALID' &&
          row.inCurrentPeriod === true &&
          [row.productId, row.productName].some(
            (field) => typeof field === 'string' && field.toLowerCase().includes('coding'),
          )
        ) {
          plan = typeof row.productName === 'string' ? row.productName : String(row.productId)
          break
        }
      }
  }
  const available: SubscriptionQuota['resets'] = []
  if (resets) {
    const row = quotaRecord(data(resets))
    for (const [key, id, label] of [
      ['available_five_hour_resets', 'FIVE_HOUR', 'Reset five-hour usage'],
      ['available_week_resets', 'WEEK', 'Reset weekly usage'],
    ]) {
      const list = row[key]
      if (!Array.isArray(list)) throw new Error('Invalid Z.AI reset status')
      const expiry = list
        .map((item) => quotaRecord(item).expire_at)
        .filter(
          (value): value is number =>
            typeof value === 'number' && Number.isFinite(value) && value > observedAt / 1000,
        )
        .sort((a, b) => a - b)
      if (expiry.length)
        available.push({
          id,
          label,
          count: expiry.length,
          expiresAt: expiry[0]! * 1000,
        })
    }
  }
  return {
    observedAt,
    plan,
    windows,
    resets: available,
    resetHistory: resets
      ? (['latest_five_hour_reset_history', 'latest_week_reset_history'] as const).flatMap(
          (key) => {
            const history = quotaRecord(data(resets))[key]
            if (!history) return []
            const time = quotaRecord(history).used_at
            return typeof time === 'number' && Number.isFinite(time) && time > 0
              ? [
                  {
                    label: key.includes('five_hour') ? 'Five-hour reset' : 'Weekly reset',
                    status: 'used',
                    usedAt: time * 1000,
                  },
                ]
              : []
          },
        )
      : [],
    resetStatus: resets
      ? `${available.length} reset types available`
      : 'Reset status unavailable. A ZCode sign-in is required.',
  }
}
export function zaiQuotaAccount(store: ZaiStore, transport: typeof fetch = fetch) {
  const read = async (name: string, signal: AbortSignal) => {
    const account = await store.read(name)
    if (!account) throw new Error('The Z.AI account is no longer stored')
    const usage = await subscriptionJson(
      'https://api.z.ai/api/monitor/usage/quota/limit',
      { Authorization: account.apiKey },
      signal,
      transport,
    )
    let subscription: unknown, resets: unknown
    try {
      subscription = await subscriptionJson(
        'https://api.z.ai/api/biz/subscription/list',
        { Authorization: account.apiKey },
        signal,
        transport,
      )
    } catch {
      signal.throwIfAborted()
    }
    const resetHeaders =
      account.zcodeToken && account.oauthAccessToken
        ? {
            Authorization: `Bearer ${account.zcodeToken}`,
            'X-Bigmodel-Authorization': account.oauthAccessToken,
            'Bigmodel-Target-Type': 'PERSONAL',
          }
        : undefined
    if (resetHeaders)
      try {
        resets = await subscriptionJson(
          'https://zcode.z.ai/api/v1/coding-plan/reset/status',
          resetHeaders,
          signal,
          transport,
        )
      } catch {
        signal.throwIfAborted()
      }
    if (
      (await store.read(name))?.storedAt !== account.storedAt ||
      (await store.read(name))?.apiKey !== account.apiKey
    )
      throw new Error('Z.AI account changed during quota check')
    return { account, resetHeaders, view: parseZaiQuota(usage, subscription, resets, Date.now()) }
  }
  let pending = false
  const ledger = new ResetLedger()
  return {
    async quota(name: string, signal: AbortSignal) {
      return (await read(name, signal)).view
    },
    async resetQuota(name: string, resetId: string, requestId: string, signal: AbortSignal) {
      if (pending) throw new Error('A Z.AI reset is already running')
      pending = true
      try {
        const current = await read(name, signal)
        if (!current.resetHeaders)
          throw new Error('Subscription reset authorization is unavailable')
        ledger.authorize(
          requestId,
          current.account.apiKey,
          resetId,
          current.view.resets.some((reset) => reset.id === resetId),
        )
        const result = quotaRecord(
          data(
            await subscriptionJson(
              'https://zcode.z.ai/api/v1/coding-plan/reset/use',
              current.resetHeaders,
              signal,
              transport,
              { idempotency_key: requestId, reset_type: resetId },
            ),
          ),
        )
        if (result.used !== true) throw new Error('Z.AI did not confirm the reset')
        return { ...(await read(name, signal)).view, notice: 'Subscription usage reset.' }
      } finally {
        pending = false
      }
    },
  }
}
