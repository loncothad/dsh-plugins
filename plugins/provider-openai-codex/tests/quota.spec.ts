import { expect, it, vi } from 'vitest'
import type { CodexAdapter } from '../src/adapter.ts'
import { codexQuotaAccount, parseCodexQuota } from '../src/quota.ts'
import type { CodexAuthorizationStore } from '../src/store.ts'

const usage = {
  plan_type: 'pro',
  rate_limit: {
    primary_window: { used_percent: 75, limit_window_seconds: 18000, reset_at: 2000000000 },
  },
  additional_rate_limits: [
    {
      limit_name: 'Fast models',
      rate_limit: {
        secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 2000000001 },
      },
    },
  ],
}
const credits = {
  credits: [
    {
      id: 'available',
      status: 'available',
      title: 'Reset usage',
      expires_at: '2035-01-01T00:00:00Z',
    },
    { id: 'spent', status: 'used' },
    { id: 'expired', status: 'available', expires_at: '2020-01-01T00:00:00Z' },
  ],
}
it('maps all quota windows and filters spent/expired reset entitlements', () => {
  expect(parseCodexQuota(usage, credits, Date.now())).toMatchObject({
    plan: 'pro',
    windows: [
      { usedPercent: 75, resetsAt: 2000000000000 },
      { label: 'Fast models: Secondary', usedPercent: 10 },
    ],
    resets: [{ id: 'available' }],
  })
})
it('reads a named inactive account without switching and sends scoped idempotent resets only when available', async () => {
  const account = {
    name: 'inactive',
    tokens: { accessToken: 'private-access' },
    accountId: 'account-two',
  }
  const adapter = { accountTokens: vi.fn(async () => account) } as unknown as CodexAdapter
  const store = { read: vi.fn(async () => account) } as unknown as CodexAuthorizationStore
  const requests: { url: string; init?: RequestInit }[] = []
  const transport = vi.fn(async (url, init) => {
    requests.push({ url: String(url), init })
    return Response.json(
      String(url).endsWith('/consume')
        ? { code: 'reset' }
        : String(url).endsWith('/usage')
          ? usage
          : credits,
    )
  }) as unknown as typeof fetch
  const service = codexQuotaAccount(adapter, store, transport),
    signal = AbortSignal.timeout(5000)
  await service.quota('inactive', signal)
  expect(adapter.accountTokens).toHaveBeenCalledWith('inactive', signal)
  expect(requests[0]?.init?.headers).toMatchObject({ 'ChatGPT-Account-Id': 'account-two' })
  await expect(
    service.resetQuota('inactive', 'spent', 'same-operation-id', signal),
  ).rejects.toThrow('no longer available')
  expect(requests.some((row) => row.url.endsWith('/consume'))).toBe(false)
  await service.resetQuota('inactive', 'available', 'same-operation-id', signal)
  expect(
    JSON.parse(String(requests.find((row) => row.url.endsWith('/consume'))?.init?.body)),
  ).toEqual({ redeem_request_id: 'same-operation-id', credit_id: 'available' })
})
