import { createElement as h } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { AuthRemote } from '../../src/auth-wire.ts'
import { subscriptionControls } from '../../src/quota-client.ts'

const value = {
  observedAt: 1000,
  plan: 'Pro',
  windows: [{ label: 'Five hour', usedPercent: 40 }],
  resets: [{ id: 'credit', label: 'Use reset credit' }],
  resetStatus: '1 available',
}
it('requires explicit confirmation and targets the displayed account using one redemption ID', async () => {
  const quota = vi.fn(async () => ({ ok: true, value })),
    resetQuota = vi.fn(async () => ({ ok: true, value: { ...value, notice: 'reset' } }))
  const Quota = subscriptionControls(async () => ({ quota, resetQuota }) as unknown as AuthRemote)
  let renderer: ReturnType<typeof create>
  await act(async () => {
    renderer = create(h(Quota, { name: 'inactive' }))
  })
  const button = (text: string) =>
    renderer.root.findAllByType('button').find((button) => button.children.includes(text))!
  expect(quota).toHaveBeenCalledWith('inactive')
  await act(async () => button('Use reset').props.onClick())
  expect(resetQuota).not.toHaveBeenCalled()
  await act(async () => button('Confirm quota reset').props.onClick())
  expect(resetQuota).toHaveBeenCalledWith(
    'inactive',
    'credit',
    expect.stringMatching(/^[a-f0-9-]{36}$/),
  )
  act(() => renderer.unmount())
})
