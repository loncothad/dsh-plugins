import type { SubscriptionQuota } from './quota-wire.ts'
export function remainingQuota(window: SubscriptionQuota['windows'][number]) {
  const amount =
    window.remaining ??
    (window.limit !== undefined && window.used !== undefined
      ? Math.max(0, window.limit - window.used)
      : undefined)
  const percent =
    window.usedPercent !== undefined
      ? Math.max(0, Math.min(100, 100 - window.usedPercent))
      : amount !== undefined && window.limit && window.limit > 0
        ? Math.max(0, Math.min(100, (amount / window.limit) * 100))
        : undefined
  return { amount, percent }
}
export function renewalCountdown(timestamp: number, now: number): string {
  if (timestamp <= now) return 'Renewal due; refresh status'
  let minutes = Math.ceil((timestamp - now) / 60000)
  const days = Math.floor(minutes / 1440)
  minutes %= 1440
  const hours = Math.floor(minutes / 60)
  minutes %= 60
  return `${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${minutes || (!days && !hours) ? `${minutes}m ` : ''}until renew`.trim()
}
export function quotaWindowTitle(window: SubscriptionQuota['windows'][number]): string {
  const name = window.label
    .replace(/: (Primary|Secondary)$/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
  const seconds = window.windowSeconds
  if (!seconds) return name
  const duration =
    seconds % 86400 === 0
      ? `${seconds / 86400} day`
      : seconds % 3600 === 0
        ? `${seconds / 3600} hour`
        : `${Math.round(seconds / 60)} minute`
  return `${name} · ${duration} allowance`
}
