import type { Context } from '@deepseek-ai/cordis'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { forwardRef, createElement as h } from 'react'
import { expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: forwardRef(({ children }: Record<string, unknown>, ref) =>
    h('button', { type: 'button', ref }, children as React.ReactNode),
  ),
}))

import { permissionControls, selectPolicyApproval } from '../../src/client/permissions.ts'

it('coexists with the native approval detail owner and selects policy prompts only', () => {
  const core = new SlotCore(),
    register = core.register.bind(core) as (options: unknown, component: unknown) => unknown
  register(
    {
      name: 'root',
      children: {
        'conversation.composer': { kind: 'chain', scope: 'session' },
        'conversation.input.left': { kind: 'list', scope: 'session' },
      },
    },
    () => null,
  )
  register(
    {
      name: 'conversation.composer',
      priority: 1,
      select: () => null,
      children: { 'conversation.approval.detail': { kind: 'single', scope: 'session' } },
    },
    () => null,
  )
  const services = new Map<string, unknown>()
  const ctx = {
    root: undefined,
    get: (key: string) => services.get(key),
    provide: (key: string, value: unknown) => services.set(key, value),
    effect: (f: () => unknown) => f(),
    slots: { inject: (_slot: string, f: () => void) => f(), register },
    remote: {},
  } as unknown as Context
  Object.assign(ctx, { root: ctx })
  expect(() => permissionControls(ctx)).not.toThrow()
  expect(
    selectPolicyApproval({
      pendingInteraction: {
        kind: 'approval',
        reason: 'Policy review: bash. Review this action before it runs.',
      },
    } as unknown as ComposerChainProps),
  ).not.toBeNull()
  for (const pendingInteraction of [
    undefined,
    { kind: 'approval', reason: 'Native sandbox escalation' },
    { kind: 'user-questions' },
  ])
    expect(selectPolicyApproval({ pendingInteraction } as unknown as ComposerChainProps)).toBeNull()
})
