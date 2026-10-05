import { expect, it } from 'vitest'
import { subscriptionJson } from '../src/quota.ts'
import { parseSubscriptionQuota } from '../src/quota-wire.ts'
import { ResetLedger } from '../src/reset-ledger.ts'

it('strips unadvertised server credentials and rejects invalid public quota numbers', () => {
  const row = {
    observedAt: 1,
    plan: 'Pro',
    windows: [],
    resets: [],
    resetStatus: 'unknown',
    access_token: 'secret',
  }
  expect(parseSubscriptionQuota(row)).not.toHaveProperty('access_token')
  expect(() =>
    parseSubscriptionQuota({ ...row, windows: [{ label: 'test', usedPercent: NaN }] }),
  ).toThrow('metric')
})
it('cancels blocked metadata reads and bounds response bytes without returning raw error bodies', async () => {
  const controller = new AbortController()
  const operation = subscriptionJson(
    'https://example.test/usage',
    {},
    controller.signal,
    (async () => new Response(new ReadableStream({ start() {} }))) as typeof fetch,
  )
  const rejected = expect(operation).rejects.toThrow('aborted')
  await Promise.resolve()
  await Promise.resolve()
  controller.abort()
  await rejected
  await expect(
    subscriptionJson(
      'https://example.test',
      {},
      AbortSignal.timeout(5000),
      (async () => new Response('x'.repeat(300000))) as typeof fetch,
    ),
  ).rejects.toThrow('size limit')
})
it('reuses an authorized reset ID after an unknown response and prevents changing its target', () => {
  const ledger = new ResetLedger()
  ledger.authorize('one', 'account', 'credit', true)
  expect(() => ledger.authorize('one', 'account', 'credit', false)).not.toThrow()
  expect(() => ledger.authorize('one', 'other', 'credit', true)).toThrow('another account')
  expect(() => ledger.authorize('two', 'account', 'spent', false)).toThrow('no longer available')
})
