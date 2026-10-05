import { expect, it } from 'vitest'
import { remainingQuota, renewalCountdown } from '../src/quota-presentation.ts'

it('shows remaining allowance using reported counts or used percentages without treating unknown as zero', () => {
  expect(remainingQuota({ label: 'weekly', usedPercent: 10 })).toEqual({
    amount: undefined,
    percent: 90,
  })
  expect(remainingQuota({ label: 'daily', limit: 200, used: 50 })).toEqual({
    amount: 150,
    percent: 75,
  })
  expect(remainingQuota({ label: 'unknown' })).toEqual({ amount: undefined, percent: undefined })
})
it('formats renewal countdowns in days, hours and minutes and marks an elapsed observation as due', () => {
  expect(renewalCountdown((2 * 1440 + 3 * 60 + 4) * 60000, 0)).toBe('2d 3h 4m until renew')
  expect(renewalCountdown(1000, 0)).toBe('1m until renew')
  expect(renewalCountdown(1000, 2000)).toContain('refresh status')
})
