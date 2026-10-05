import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import { createElement as h } from 'react'
import type { ReactTestRenderer } from 'react-test-renderer'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { registerConfiguration } from '../../../../support/plugin-runtime/src/client.ts'
import { providerControls } from '../../src/client/providers.ts'

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  vi.unstubAllGlobals()
})

it('saves model preferences and credentials together and preserves drafts across an external revision', async () => {
  const listeners = new Set<() => void>()
  let snapshot = {
    status: 'ready',
    writable: true,
    revision: 4,
    value: {
      modelProviders: { 'vendor/retired': 'old/provider', 'vendor/model': 'provider/first' },
    },
  }
  const mutate = vi.fn(async () => false)
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate,
  }
  const schema = {
    type: 'object',
    dict: {
      apiKey: { type: 'string', meta: { role: 'secret' } },
      modelProviders: { type: 'dict', meta: {} },
    },
    meta: {},
  }
  const description = { view: { namespaces: [{ ns: 'provider-openrouter', schema }] } }
  let Page: ComponentType | undefined
  const ctx = {
    configForms: {
      get: () => form,
      describe: () => ({ getSnapshot: () => description, subscribe: () => () => {} }),
    },
    settingsSchema: { rehydrate: (value: unknown) => value },
    locale: { register() {}, bind: () => (key: string) => key },
    effect: (callback: () => void) => callback(),
    inject() {},
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: (_registration: unknown, component: ComponentType) => {
        Page = component
      },
    },
  } as unknown as Context
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith('/models')
              ? { data: [{ id: 'vendor/model', name: 'Current model' }] }
              : url.endsWith('/endpoints')
                ? { data: { endpoints: [{ tag: 'provider/first' }, { tag: 'provider/second' }] } }
                : { data: [] },
          ),
          { headers: { 'content-type': 'application/json' } },
        ),
    ),
  )
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-provider-openrouter',
    rowId: 'provider-openrouter',
    sections: [{ fields: ['modelProviders'], component: providerControls(ctx) }],
  })
  await act(async () => {
    renderer = create(h(Page!))
    await Promise.resolve()
  })
  const root = renderer!.root
  expect(root.findAllByType('textarea')).toHaveLength(0)
  expect(
    root.findAllByType('option').some((option) => option.props.value === 'vendor/retired'),
  ).toBe(true)
  act(() =>
    root.findByProps({ type: 'password' }).props.onChange({ target: { value: 'new-credential' } }),
  )
  await act(async () => {
    root
      .findByProps({ 'aria-label': 'OpenRouter model' })
      .props.onChange({ target: { value: 'vendor/model' } })
    await Promise.resolve()
  })
  act(() => root.findByProps({ type: 'radio', value: 'provider/second' }).props.onChange())
  expect(mutate).not.toHaveBeenCalled()
  act(() => {
    snapshot = { ...snapshot, revision: 5 }
    listeners.forEach((listener) => {
      listener()
    })
  })
  await act(async () => root.findByType('form').props.onSubmit({ preventDefault() {} }))
  expect(mutate).toHaveBeenCalledWith(
    [
      { op: 'set', path: ['apiKey'], value: 'new-credential' },
      {
        op: 'set',
        path: ['modelProviders'],
        value: { 'vendor/retired': 'old/provider', 'vendor/model': 'provider/second' },
      },
    ],
    4,
  )
  expect(root.findByProps({ type: 'password' }).props.value).toBe('new-credential')
  expect(root.findByProps({ type: 'radio', value: 'provider/second' }).props.checked).toBe(true)
  act(() =>
    root
      .findAllByType('button')
      .find((button) => button.children.includes('reload'))!
      .props.onClick(),
  )
  expect(root.findByProps({ type: 'password' }).props.value).toBe('')
  expect(root.findByProps({ type: 'radio', value: 'provider/first' }).props.checked).toBe(true)
  act(() => root.findByProps({ type: 'radio', value: '' }).props.onChange())
  await act(async () => root.findByType('form').props.onSubmit({ preventDefault() {} }))
  expect(mutate).toHaveBeenLastCalledWith(
    [{ op: 'set', path: ['modelProviders'], value: { 'vendor/retired': 'old/provider' } }],
    5,
  )
})
