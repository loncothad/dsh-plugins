import type { Context } from '@deepseek-ai/cordis'
import { createElement as h } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { privateStateClient } from '../../src/private-state-client.ts'

it('shares one authenticated mount across dashboard and modal readers for the same channel', async () => {
  const mount = vi.fn(async () => {}),
    read = vi.fn(async () => ({ ok: true, value: '{"revision":2}' }))
  const ctx = {
    remote: { $mount: mount, pluginState_goals: { read } },
    inject: (_names: string[], callback: (scope: Context) => void) => callback(ctx),
    effect: (callback: () => unknown) => callback(),
  } as unknown as Context
  const useOne = privateStateClient(ctx, 'goals', (v) => v as { revision: number }),
    useTwo = privateStateClient(ctx, 'goals', (v) => v as { revision: number })
  function One() {
    return h('span', null, useOne('session')?.revision)
  }
  function Two() {
    return h('span', null, useTwo('session')?.revision)
  }
  let view: ReturnType<typeof create>
  await act(async () => {
    view = create(h('div', null, h(One), h(Two)))
  })
  expect(mount).toHaveBeenCalledOnce()
  expect(read).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(view!.toJSON())).toContain('2')
  act(() => view!.unmount())
})

it('separates loading, missing data and unavailable data without leaking last-known state across chats', async () => {
  vi.useFakeTimers()
  const reads = new Map<string, Promise<{ ok: true; value: string }>>(),
    first = Promise.withResolvers<{ ok: true; value: string }>(),
    late = Promise.withResolvers<{ ok: true; value: string }>()
  reads.set('first', first.promise)
  reads.set('second', late.promise)
  const ctx = {
    remote: {
      $mount: async () => {},
      pluginState_observe: { read: vi.fn((id: string) => reads.get(id)) },
    },
    inject: (_names: string[], f: (c: Context) => void) => f(ctx),
    effect: (f: () => unknown) => f(),
  } as unknown as Context
  const mutable = ctx as unknown as {
    remote: { pluginState_observe: { read: (id: string) => Promise<{ ok: true; value: string }> } }
  }
  const { privateStateObservation } = await import('../../src/private-state-client.ts')
  const use = privateStateObservation(ctx, 'observe', (v) => v as { title: string } | null)
  let latest: ReturnType<typeof use> | undefined
  function View({ id }: { id: string }) {
    latest = use(id)
    return null
  }
  let view: ReturnType<typeof create>
  try {
    await act(async () => {
      view = create(h(View, { id: 'first' }))
    })
    expect(latest?.status).toBe('loading')
    await act(async () => first.resolve({ ok: true, value: '{"title":"First goal"}' }))
    expect(latest?.value).toEqual({ title: 'First goal' })
    mutable.remote.pluginState_observe.read = async () => {
      throw Error('Unavailable')
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(latest?.status).toBe('unavailable')
    expect(latest?.value).toEqual({ title: 'First goal' })
    mutable.remote.pluginState_observe.read = async () => late.promise
    await act(async () => view!.update(h(View, { id: 'second' })))
    expect(latest?.status).toBe('loading')
    expect(latest?.value).toBeUndefined()
    await act(async () => late.resolve({ ok: true, value: 'null' }))
    expect(latest?.status).toBe('ready')
    expect(latest?.value).toBeNull()
  } finally {
    act(() => view!.unmount())
    vi.useRealTimers()
  }
})
