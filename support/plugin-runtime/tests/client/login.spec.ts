import type { Context } from '@deepseek-ai/cordis'
import { createElement as h } from 'react'
import type { ReactTestRenderer } from 'react-test-renderer'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { authenticationControls } from '../../src/auth-client.ts'
import type { AuthView } from '../../src/auth-wire.ts'

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})
const methods = [{ id: 'key', label: 'Enter API key' }]
const prompting: AuthView = {
  methods,
  attempt: {
    id: 'attempt',
    status: 'running',
    prompt: { id: 'prompt', kind: 'secret', message: 'API key' },
  },
}
it('handles Enter inside the login prompt without submitting configuration and prevents duplicate RPCs', async () => {
  let view = prompting
  const gate = Promise.withResolvers<AuthView>(),
    save = vi.fn()
  const answer = vi.fn(() => gate.promise.then((value) => ({ ok: true, value })))
  const ctx = {
    inject: (_names: string[], callback: (scope: Context) => void) => callback(ctx),
    effect: (callback: () => unknown) => callback(),
    remote: {
      $mount: async () => {},
      zaiAuth: { state: async () => ({ ok: true, value: view }), answer },
    },
  } as unknown as Context
  const Login = authenticationControls(ctx, 'zaiAuth')
  await act(async () => {
    renderer = create(h('form', { id: 'configuration', onSubmit: save }, h(Login)))
  })
  const root = renderer!.root
  expect(root.findAllByType('form')).toHaveLength(1)
  const input = root.findByType('input')
  expect(input.props.form).not.toBe('configuration')
  expect(input.props.type).toBe('password')
  act(() => input.props.onChange({ target: { value: 'fixture-key' } }))
  const event = {
    key: 'Enter',
    nativeEvent: { isComposing: false },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  }
  await act(async () => {
    root.findByType('input').props.onKeyDown(event)
    root.findByType('input').props.onKeyDown(event)
  })
  expect(event.preventDefault).toHaveBeenCalledTimes(2)
  expect(event.stopPropagation).toHaveBeenCalledTimes(2)
  expect(answer).toHaveBeenCalledExactlyOnceWith('attempt', 'prompt', 'fixture-key')
  expect(save).not.toHaveBeenCalled()
  await act(async () => {
    view = { methods, attempt: { id: 'attempt', status: 'authorized' } }
    gate.resolve(view)
  })
  expect(root.findAllByType('input')).toHaveLength(0)
  expect(JSON.stringify(renderer!.toJSON())).not.toContain('fixture-key')
})
it('leaves IME composition Enter alone and does not send an incomplete prompt', async () => {
  const answer = vi.fn()
  const ctx = {
    inject: (_names: string[], callback: (scope: Context) => void) => callback(ctx),
    effect: (callback: () => unknown) => callback(),
    remote: {
      $mount: async () => {},
      codexAuth: { state: async () => ({ ok: true, value: prompting }), answer },
    },
  } as unknown as Context
  const Login = authenticationControls(ctx, 'codexAuth')
  await act(async () => {
    renderer = create(h(Login))
  })
  const root = renderer!.root
  act(() => root.findByType('input').props.onChange({ target: { value: 'composing' } }))
  const event = {
    key: 'Enter',
    nativeEvent: { isComposing: true },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  }
  act(() => root.findByType('input').props.onKeyDown(event))
  expect(answer).not.toHaveBeenCalled()
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(root.findByType('h3').children).toEqual(['Sign in to ChatGPT Codex'])
})
it('ignores a status response captured before a new login operation began', async () => {
  let view: AuthView = { methods },
    reads = 0
  const stale = Promise.withResolvers<AuthView>(),
    begin = Promise.withResolvers<AuthView>()
  const state = vi.fn(async () => ({
    ok: true as const,
    value: ++reads === 2 ? await stale.promise : view,
  }))
  const ctx = {
    inject: (_names: string[], callback: (scope: Context) => void) => callback(ctx),
    effect: (callback: () => unknown) => callback(),
    remote: {
      $mount: async () => {},
      zaiAuth: { state, begin: () => begin.promise.then((value) => ({ ok: true, value })) },
    },
  } as unknown as Context
  const Login = authenticationControls(ctx, 'zaiAuth')
  await act(async () => {
    renderer = create(h(Login))
  })
  const button = (text: string) =>
    renderer!.root.findAllByType('button').find((button) => button.children.includes(text))!
  await act(async () => button('Refresh login state').props.onClick())
  expect(reads).toBe(2)
  act(() => button('Enter API key').props.onClick())
  await act(async () =>
    stale.resolve({
      methods,
      attempt: { id: 'old', status: 'authorized', notice: { message: 'STALE RESPONSE' } },
    }),
  )
  expect(JSON.stringify(renderer!.toJSON())).not.toContain('STALE RESPONSE')
  await act(async () => {
    view = {
      methods,
      attempt: { id: 'new', status: 'running', notice: { message: 'Current login' } },
    }
    begin.resolve(view)
  })
  expect(JSON.stringify(renderer!.toJSON())).toContain('Current login')
})
