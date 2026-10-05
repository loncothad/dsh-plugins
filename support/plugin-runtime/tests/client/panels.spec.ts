import type { Context } from '@deepseek-ai/cordis'
import { forwardRef, createElement as h, useEffect } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: forwardRef<HTMLButtonElement, Record<string, unknown>>(({ children, ...props }, ref) =>
    h('button', { type: 'button', ...props, ref }, children as React.ReactNode),
  ),
  Menu: ({ items, anchor }: { items: { id: string }[]; anchor: React.ReactNode }) =>
    h('div', { 'data-items': items.map((i) => i.id).join(',') }, anchor),
  Modal: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? h('section', { 'data-modal': true }, children) : null,
}))

import {
  openConversationPanel,
  registerConversationPanel,
} from '../../src/conversation-panels-client.ts'

it('omits conditional panels until supported, updates visibility, and removes disposed membership', async () => {
  let Toolbar: React.ComponentType<Record<string, unknown>> | undefined
  const resources = new Map<string, unknown>(),
    dispose: (() => void)[] = []
  const ctx = {
    root: undefined,
    get: (name: string) => resources.get(name),
    provide: (name: string, value: unknown) => resources.set(name, value),
    effect: (callback: () => () => void) => {
      dispose.push(callback())
    },
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: (_options: unknown, component: React.ComponentType<Record<string, unknown>>) => {
        Toolbar = component
      },
    },
  } as unknown as Context
  Object.assign(ctx, { root: ctx })
  let enabled = false,
    report: ((v: boolean) => void) | undefined
  function Visibility({ onChange }: { onChange(v: boolean): void }) {
    report = onChange
    useEffect(() => onChange(enabled), [onChange])
    return null
  }
  registerConversationPanel(ctx, {
    id: 'always',
    label: 'Tools',
    component: () => h('span', null, 'Panel contents'),
  })
  registerConversationPanel(ctx, {
    id: 'backends',
    label: 'Model providers',
    visibility: Visibility,
    component: () => null,
  })
  let view: ReturnType<typeof create>
  await act(async () => {
    view = create(h(Toolbar!, { sessionId: 'one' }))
  })
  expect(view!.root.findByProps({ 'data-items': 'always' })).toBeDefined()
  act(() => {
    expect(openConversationPanel(ctx, 'another', 'always')).toBe(true)
  })
  expect(view!.root.findAllByProps({ 'data-modal': true })).toHaveLength(0)
  act(() => {
    expect(openConversationPanel(ctx, 'one', 'always')).toBe(true)
  })
  expect(view!.root.findAllByProps({ 'data-modal': true })).toHaveLength(1)
  expect(openConversationPanel(ctx, 'one', 'missing')).toBe(false)
  await act(async () => {
    enabled = true
    report!(true)
  })
  expect(view!.root.findByProps({ 'data-items': 'always,backends' })).toBeDefined()
  await act(async () => dispose.at(-1)!())
  expect(view!.root.findByProps({ 'data-items': 'always' })).toBeDefined()
  act(() => view!.unmount())
})
