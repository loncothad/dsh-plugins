/** Public subscription status contains only selected quota metadata, never server payloads. */
export interface SubscriptionQuota {
  observedAt: number
  plan: string
  windows: {
    label: string
    usedPercent?: number
    used?: number
    limit?: number
    remaining?: number
    resetsAt?: number
    windowSeconds?: number
  }[]
  resets: { id: string; label: string; expiresAt?: number; count?: number }[]
  resetHistory?: { label: string; status: string; expiresAt?: number; usedAt?: number }[]
  resetStatus: string
  notice?: string
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid subscription quota')
  return value as Record<string, unknown>
}
const text = (value: unknown, max = 512): string => {
  if (typeof value !== 'string' || value.length > max)
    throw new TypeError('Invalid subscription text')
  return value
}
export function parseSubscriptionQuota(value: unknown): SubscriptionQuota {
  const row = record(value)
  if (!Number.isFinite(row.observedAt)) throw new TypeError('Invalid quota observation')
  if (
    !Array.isArray(row.windows) ||
    row.windows.length > 128 ||
    !Array.isArray(row.resets) ||
    row.resets.length > 128
  )
    throw new TypeError('Invalid subscription limits')
  return {
    observedAt: row.observedAt as number,
    plan: text(row.plan),
    resetStatus: text(row.resetStatus),
    ...(row.notice === undefined ? {} : { notice: text(row.notice) }),
    windows: row.windows.map((value) => {
      const source = record(value),
        result: SubscriptionQuota['windows'][number] = { label: text(source.label) }
      for (const field of [
        'usedPercent',
        'used',
        'limit',
        'remaining',
        'resetsAt',
        'windowSeconds',
      ] as const) {
        if (source[field] === undefined) continue
        if (
          typeof source[field] !== 'number' ||
          !Number.isFinite(source[field]) ||
          source[field] < 0
        )
          throw new TypeError('Invalid quota metric')
        result[field] = source[field]
      }
      return result
    }),
    resets: row.resets.map((value) => {
      const source = record(value)
      if (
        source.count !== undefined &&
        (typeof source.count !== 'number' ||
          !Number.isSafeInteger(source.count) ||
          source.count < 1 ||
          source.count > 128)
      )
        throw new TypeError('Invalid reset count')
      if (
        source.expiresAt !== undefined &&
        (typeof source.expiresAt !== 'number' ||
          !Number.isFinite(source.expiresAt) ||
          source.expiresAt <= 0)
      )
        throw new TypeError('Invalid reset expiry')
      return {
        id: text(source.id, 256),
        label: text(source.label),
        ...(source.expiresAt === undefined ? {} : { expiresAt: source.expiresAt as number }),
        ...(source.count === undefined ? {} : { count: Number(source.count) }),
      }
    }),
    ...(row.resetHistory === undefined
      ? {}
      : {
          resetHistory: (() => {
            if (!Array.isArray(row.resetHistory) || row.resetHistory.length > 128)
              throw new TypeError('Invalid reset history')
            return row.resetHistory.map((value) => {
              const source = record(value)
              const result: NonNullable<SubscriptionQuota['resetHistory']>[number] = {
                label: text(source.label),
                status: text(source.status),
              }
              for (const field of ['expiresAt', 'usedAt'] as const) {
                if (source[field] === undefined) continue
                if (
                  typeof source[field] !== 'number' ||
                  !Number.isFinite(source[field]) ||
                  source[field] <= 0
                )
                  throw new TypeError('Invalid reset history time')
                result[field] = source[field]
              }
              return result
            })
          })(),
        }),
  }
}
