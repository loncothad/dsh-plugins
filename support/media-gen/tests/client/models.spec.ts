import type { Context } from '@deepseek-ai/cordis'
import { createElement as h, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@deepseek-ai/dsh-client-ui-primitives',
  )
  return {
    ...actual,
    Modal: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? h('div', { role: 'dialog' }, children) : null,
  }
})

import { mediaModelControls } from '../../src/client.ts'

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  vi.useRealTimers()
})
it('loads the chooser on demand, shows model prices and transitions, and stages selection without inference', async () => {
  vi.useFakeTimers()
  const list = vi.fn(async (output: string) => ({
      ok: true,
      value: {
        models: [
          {
            id: `vendor/${output}`,
            name: output,
            outputs: [output],
            inputs: ['text'],
            pricing: 'USD 0.1/image',
            protocol: 'fal',
            releasedAt: Date.UTC(2026, 1, 26),
          },
        ],
        total: 1,
      },
    })),
    describe = vi.fn(async (id: string) => ({
      ok: true,
      value: {
        id,
        name: 'Selected image',
        outputs: ['image'],
        inputs: ['text'],
        pricing: 'USD 0.1/image',
        protocol: 'fal',
      },
    }))
  const ctx = {
    inject: (_names: string[], callback: (scope: Context) => void) => callback(ctx),
    effect: (callback: () => unknown) => callback(),
    remote: { $mount: async () => {}, falMediaCatalog: { list, describe } },
  } as unknown as Context
  const Models = mediaModelControls(ctx, 'falMediaCatalog', [
    { field: 'imageModel', output: 'image', label: 'Image model' },
  ])
  let draft: Record<string, string> = {}
  function Form() {
    const [value, setValue] = useState<Record<string, string>>({
      imageModel: '',
      mediaModelOptions: '{}',
    })
    return h(Models, {
      disabled: false,
      setError: () => {},
      getValue: (field) => value[field] ?? '',
      setValue: (field, next) => {
        draft = { ...draft, [field]: next }
        setValue((previous) => ({ ...previous, [field]: next }))
      },
    })
  }
  await act(async () => {
    renderer = create(h(Form))
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(list).not.toHaveBeenCalled()
  act(() => renderer!.root.findByProps({ 'aria-label': 'Choose Image model' }).props.onClick())
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(list).toHaveBeenCalledWith('image', '', 0, 'newest')
  expect(JSON.stringify(renderer!.toJSON())).toContain('USD 0.1/image')
  expect(JSON.stringify(renderer!.toJSON())).toContain('text → image · fal')
  expect(JSON.stringify(renderer!.toJSON())).toContain('Released on fal 2026-02-26')
  expect(JSON.stringify(renderer!.toJSON())).toContain(
    'metadata updates do not change release order',
  )
  act(() =>
    renderer!.root
      .findByProps({ 'aria-label': 'Sort models' })
      .props.onChange({ target: { value: 'name' } }),
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(list).toHaveBeenLastCalledWith('image', '', 0, 'name')
  act(() => renderer!.root.findAllByProps({ role: 'option' })[1]!.props.onClick())
  await act(async () => {})
  expect(draft).toEqual({ imageModel: 'vendor/image' })
  expect(renderer!.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
})
