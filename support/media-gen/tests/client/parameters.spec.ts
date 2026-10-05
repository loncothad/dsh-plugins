import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import { createElement as h } from 'react'
import type { ReactTestRenderer } from 'react-test-renderer'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { registerConfiguration } from '../../../../support/plugin-runtime/src/client.ts'
import { mediaModelControls } from '../../src/client.ts'

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  vi.useRealTimers()
})
it('shares typed parameter edits with advanced JSON and blocks invalid saves', async () => {
  vi.useFakeTimers()
  const listeners = new Set<() => void>()
  const snapshot = {
    status: 'ready',
    writable: true,
    revision: 1,
    value: {
      imageModel: 'vendor/image',
      mediaModelOptions: { 'vendor/image': { duration: 4 }, 'vendor/other': { seed: 42 } },
    },
  }
  const mutate = vi.fn(async () => true)
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
      imageModel: { type: 'string', meta: {} },
      mediaModelOptions: { type: 'dict', meta: {} },
    },
    meta: {},
  }
  const description = { view: { namespaces: [{ ns: 'provider-fal', schema }] } }
  let Page: ComponentType | undefined
  const ctx = {
    inject: (_names: string[], callback: (scope: Context) => void) => callback(ctx),
    configForms: {
      get: () => form,
      describe: () => ({ getSnapshot: () => description, subscribe: () => () => {} }),
    },
    settingsSchema: { rehydrate: (value: unknown) => value },
    locale: { register() {}, bind: () => (key: string) => key },
    effect: (callback: () => void) => callback(),
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: (_registration: unknown, component: ComponentType) => {
        Page = component
      },
    },
    remote: {
      $mount: async () => {},
      falMediaCatalog: {
        describe: async () => ({
          ok: true,
          value: {
            id: 'vendor/image',
            name: 'Image',
            outputs: ['image'],
            parameters: {
              duration: { type: 'number', values: [4, 8] },
              generate_audio: { type: 'boolean' },
            },
          },
        }),
        list: async () => ({
          ok: true,
          value: {
            models: [
              {
                id: 'vendor/image',
                name: 'Image',
                outputs: ['image'],
                parameters: {
                  duration: { type: 'number', values: [4, 8] },
                  generate_audio: { type: 'boolean' },
                },
              },
            ],
            total: 1,
          },
        }),
      },
    },
  } as unknown as Context
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-provider-fal',
    rowId: 'provider-fal',
    sections: [
      {
        fields: ['imageModel', 'mediaModelOptions'],
        standardFields: ['mediaModelOptions'],
        component: mediaModelControls(ctx, 'falMediaCatalog', [
          { field: 'imageModel', output: 'image', label: 'Image model' },
        ]),
      },
    ],
  })
  await act(async () => {
    renderer = create(h(Page!))
    await vi.advanceTimersByTimeAsync(200)
  })
  const root = renderer!.root
  const save = () =>
    root.findAllByType('button').find((button) => button.children.includes('save'))!
  act(() =>
    root.findByType('textarea').props.onChange({
      target: { value: '{"vendor/image":{"duration":6},"vendor/other":{"seed":42}}' },
    }),
  )
  expect(save().props.disabled).toBe(true)
  await act(async () => root.findByType('form').props.onSubmit({ preventDefault() {} }))
  expect(mutate).not.toHaveBeenCalled()
  act(() =>
    root
      .findByProps({ 'aria-label': 'vendor/image: duration' })
      .props.onChange({ target: { value: '8' } }),
  )
  act(() =>
    root
      .findByProps({ 'aria-label': 'vendor/image: generate_audio' })
      .props.onChange({ target: { value: 'false' } }),
  )
  expect(JSON.parse(root.findByType('textarea').props.value)).toEqual({
    'vendor/image': { duration: 8, generate_audio: false },
    'vendor/other': { seed: 42 },
  })
  expect(save().props.disabled).toBe(false)
  await act(async () => root.findByType('form').props.onSubmit({ preventDefault() {} }))
  expect(mutate).toHaveBeenCalledWith(
    [
      {
        op: 'set',
        path: ['mediaModelOptions'],
        value: {
          'vendor/image': { duration: 8, generate_audio: false },
          'vendor/other': { seed: 42 },
        },
      },
    ],
    1,
  )
  act(() => root.findByType('textarea').props.onChange({ target: { value: '' } }))
  expect(save().props.disabled).toBe(true)
  act(() =>
    root
      .findAllByType('button')
      .find((button) => button.children.includes('reset'))!
      .props.onClick(),
  )
  expect(save().props.disabled).toBe(false)
  await act(async () => root.findByType('form').props.onSubmit({ preventDefault() {} }))
  expect(mutate).toHaveBeenLastCalledWith([{ op: 'unset', path: ['mediaModelOptions'] }], 1)
})
