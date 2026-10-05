import { expect, it, vi } from 'vitest'
import { parseZaiQuota, zaiQuotaAccount } from '../src/quota.ts'
import type { ZaiStore } from '../src/store.ts'

const usage = {
  code: 200,
  data: {
    level: 'MAX',
    limits: [{ type: 'TIME_LIMIT', percentage: 42, nextResetTime: 2000000000000, remaining: 58 }],
  },
}
const resets = {
  code: 0,
  data: { available_five_hour_resets: [{ expire_at: 2000000000 }], available_week_resets: [] },
}
it('uses official subscription status and preserves service timestamps', () => {
  const subscriptions = {
    code: 200,
    data: [
      {
        productId: 'coding-max',
        productName: 'Coding Max',
        status: 'VALID',
        inCurrentPeriod: true,
      },
    ],
  }
  expect(parseZaiQuota(usage, subscriptions, resets, 1000)).toMatchObject({
    plan: 'Coding Max',
    windows: [{ usedPercent: 42, resetsAt: 2000000000000 }],
    resets: [{ id: 'FIVE_HOUR', expiresAt: 2000000000000 }],
  })
})
it('uses both official reset credentials, rejects unavailable types and keeps keys out of quota views', async () => {
  const account = {
    kind: 'zai-subscription-v1',
    apiKey: 'private-key',
    source: 'oauth',
    storedAt: 1,
    oauthAccessToken: 'private-business',
    zcodeToken: 'private-zcode',
  }
  const store = { read: async () => account } as unknown as ZaiStore
  const transport = vi.fn(async (url) =>
    Response.json(
      String(url).endsWith('/limit')
        ? usage
        : String(url).endsWith('/list')
          ? { code: 0, data: [] }
          : String(url).endsWith('/use')
            ? { code: 0, data: { used: true } }
            : resets,
    ),
  ) as unknown as typeof fetch
  const service = zaiQuotaAccount(store, transport),
    signal = AbortSignal.timeout(5000)
  const view = await service.quota('subscription', signal)
  expect(JSON.stringify(view)).not.toContain('private-')
  await expect(service.resetQuota('subscription', 'WEEK', 'request-id', signal)).rejects.toThrow(
    'no longer available',
  )
  await service.resetQuota('subscription', 'FIVE_HOUR', 'request-id', signal)
  const use = vi.mocked(transport).mock.calls.find(([url]) => String(url).endsWith('/use'))
  expect(use?.[1]?.headers).toMatchObject({
    Authorization: 'Bearer private-zcode',
    'X-Bigmodel-Authorization': 'private-business',
    'Bigmodel-Target-Type': 'PERSONAL',
  })
  expect(JSON.parse(String(use?.[1]?.body))).toEqual({
    idempotency_key: 'request-id',
    reset_type: 'FIVE_HOUR',
  })
})
it('does not offer resets for API-key-only sign-ins', async () => {
  const store = { read: async () => ({ apiKey: 'private', storedAt: 1 }) } as unknown as ZaiStore
  const transport = vi.fn(async () => Response.json(usage)) as unknown as typeof fetch
  const view = await zaiQuotaAccount(store, transport).quota(
    'subscription',
    AbortSignal.timeout(5000),
  )
  expect(view.resets).toEqual([])
  expect(vi.mocked(transport).mock.calls.some(([url]) => String(url).includes('/reset/'))).toBe(
    false,
  )
})
