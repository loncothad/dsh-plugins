import type { Context } from '@deepseek-ai/cordis'
import type { PendingApproval } from '@deepseek-ai/dsh-client-ui-approval/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  connectRemote,
  registerConversationPanel,
  remoteValue,
} from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h, useEffect, useRef, useState } from 'react'
import { contribution, type PermissionsView, permissionsViewSchema } from '../wire.ts'

type ApprovalProps = PropsRuntime<'conversation.composer'> & { matched: PendingApproval }
export function selectPolicyApproval({
  pendingInteraction,
}: ComposerChainProps): PendingApproval | null {
  return pendingInteraction?.kind === 'approval' &&
    (pendingInteraction as PendingApproval).reason?.startsWith('Policy review:')
    ? (pendingInteraction as PendingApproval)
    : null
}
export function permissionControls(ctx: Context) {
  const remote = connectRemote(ctx, 'policyPermissions', contribution)
  const read = async (id: string) =>
    permissionsViewSchema.parse(JSON.parse(remoteValue(await (await remote()).read(id))))
  function Panel(props: PropsRuntime<'conversation.input.left'>) {
    const [view, setView] = useState<PermissionsView>(),
      [error, setError] = useState(''),
      [busy, setBusy] = useState(false)
    const current = useRef(props.sessionId)
    current.current = props.sessionId
    useEffect(() => {
      let live = true
      setView(undefined)
      setError('')
      void read(props.sessionId)
        .then((v) => {
          if (live) setView(v)
        })
        .catch((e) => {
          if (live) setError(e.message)
        })
      return () => {
        live = false
      }
    }, [props.sessionId])
    const revoke = async (id: string) => {
      const sessionId = props.sessionId
      setBusy(true)
      setError('')
      try {
        remoteValue(await (await remote()).revoke(sessionId, id))
        const v = await read(sessionId)
        if (current.current === sessionId) setView(v)
      } catch (e) {
        if (current.current === sessionId)
          setError(e instanceof Error ? e.message : 'Permission update failed')
      } finally {
        if (current.current === sessionId) setBusy(false)
      }
    }
    return h(
      'section',
      { 'aria-label': 'Policy permissions', className: 'dsh-plugin-settings dsh-plugin-panel' },
      h(
        'p',
        null,
        'Remembered approvals apply to this chat, workspace and environment. Changes to policy or sandbox settings require a new approval. Explicit denials and evidence checks still apply.',
      ),
      !view && !error ? h('p', { role: 'status' }, 'Loading permissions…') : null,
      view && !view.grants.length ? h('p', null, 'No remembered approvals in this chat.') : null,
      ...(view?.grants ?? []).map((g) =>
        h(
          'article',
          {
            key: g.id,
            style: { padding: '12px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' },
          },
          h('strong', null, g.label),
          h('p', null, g.workspace),
          h('p', null, `Expires ${new Date(g.expiresAt).toLocaleString()}`),
          h(
            Button,
            { size: 'sm', variant: 'outline', disabled: busy, onClick: () => void revoke(g.id) },
            'Revoke',
          ),
        ),
      ),
      error ? h('p', { role: 'alert' }, error) : null,
    )
  }
  function Approval(props: ApprovalProps) {
    return h(Flow, { ...props, key: props.matched.key })
  }
  function Flow(props: ApprovalProps) {
    const pending = props.matched
    const argumentsText = props.useChat((snapshot) => {
      for (const node of snapshot.nodes.values()) {
        const root =
          node.kind === 'tool-call' ? (node as ChatNode<'tool-call'>).data.root : undefined
        if (!root || root.callId !== pending.callId || 'kind' in root || root.phase !== 'start')
          continue
        try {
          const args = JSON.parse(root.argsRaw)
          return typeof args.command === 'string'
            ? args.command.slice(0, 32768)
            : JSON.stringify(args, null, 2).slice(0, 32768)
        } catch {
          return 'Tool arguments are unavailable'
        }
      }
      return undefined
    })
    const [candidate, setCandidate] = useState<PermissionsView['pending'][number]>(),
      [error, setError] = useState(''),
      [busy, setBusy] = useState(false)
    const live = useRef(true),
      waiting = useRef(false),
      composing = useRef(false),
      compositionEnded = useRef(false)
    useEffect(() => {
      live.current = true
      void read(pending.sessionId)
        .then((v) => {
          if (live.current) setCandidate(v.pending.find((p) => p.callId === pending.callId))
        })
        .catch((e) => {
          if (live.current) setError(e.message)
        })
      return () => {
        live.current = false
      }
    }, [pending])
    const answer = async (decision: 'allowed-once' | 'rejected', remember = false) => {
      if (waiting.current || !pending.answerable) return
      waiting.current = true
      setBusy(true)
      setError('')
      try {
        if (remember) {
          if (!candidate?.canRemember || !pending.callId)
            throw Error('A separate review is required for this action')
          remoteValue(
            await (await remote()).remember(
              pending.sessionId,
              pending.callId,
              candidate.requestHash,
            ),
          )
          if (!live.current || !pending.answerable) return
        }
        await pending.answer(decision)
      } catch (e) {
        if (live.current) setError(e instanceof Error ? e.message : 'Approval failed')
      } finally {
        if (live.current && pending.answerable) {
          waiting.current = false
          setBusy(false)
        }
      }
    }
    return h(
      'div',
      { className: 'dsh-policy-review-shell' },
      h('style', null, theme),
      h(
        'section',
        {
          className: 'dsh-policy-review',
          'aria-label': 'Review policy action',
          'aria-busy': busy,
          onCompositionStartCapture: () => {
            composing.current = true
          },
          onCompositionEndCapture: () => {
            composing.current = false
            compositionEnded.current = true
          },
          onKeyUpCapture: () => {
            compositionEnded.current = false
          },
          onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
            const target = event.target as Element
            if (
              event.defaultPrevented ||
              event.repeat ||
              event.nativeEvent.isComposing ||
              composing.current ||
              compositionEnded.current ||
              event.ctrlKey ||
              event.altKey ||
              event.metaKey ||
              event.shiftKey ||
              target.closest('input,textarea,select,[contenteditable]')
            )
              return
            if (
              event.key === 'Escape' ||
              (event.key === 'Enter' && !target.closest('button,a[href],[role=button]'))
            ) {
              event.preventDefault()
              event.stopPropagation()
              void answer(event.key === 'Escape' ? 'rejected' : 'allowed-once')
            }
          },
        },
        h('div', { className: 'dsh-policy-review-strip' }, 'Permission required'),
        h(
          'div',
          { className: 'dsh-policy-review-body', tabIndex: 0 },
          h('strong', null, `Review ${pending.toolName}`),
          argumentsText
            ? h(
                'pre',
                { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
                argumentsText,
              )
            : null,
          candidate
            ? h(
                'p',
                null,
                candidate.canRemember
                  ? `Approve similar: ${candidate.label}. Scoped to ${candidate.workspace}.`
                  : 'This action requires its own approval.',
              )
            : null,
          h(
            'p',
            null,
            'Saved approvals expire. Denials, evidence checks and native sandbox limits still apply.',
          ),
          error ? h('p', { role: 'alert' }, error) : null,
        ),
        h(
          'div',
          { className: 'dsh-policy-review-actions' },
          h(
            Button,
            { variant: 'outline', disabled: busy, onClick: () => void answer('rejected') },
            'Reject',
          ),
          h(
            Button,
            {
              variant: 'outline',
              disabled: busy || !candidate?.canRemember,
              onClick: () => void answer('allowed-once', true),
            },
            'Approve similar',
          ),
          h(
            Button,
            { variant: 'primary', disabled: busy, onClick: () => void answer('allowed-once') },
            'Allow once',
          ),
        ),
      ),
    )
  }
  ctx.slots.inject('conversation.composer', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer',
        priority: 0,
        select: selectPolicyApproval,
      },
      Approval,
    ),
  )
  registerConversationPanel(ctx, {
    id: 'policy-permissions',
    label: 'Policy permissions',
    order: 55,
    component: Panel,
  })
  return { Approval, Panel }
}
const theme = `.dsh-policy-review-shell{box-sizing:border-box;width:100%;padding:8px var(--dsh-composer-side-clearance,16px) 12px}.dsh-policy-review{width:100%;max-width:var(--dsh-composer-card-max-width,760px);margin:auto;border:1px solid var(--dsw-alias-state-warn-secondary);border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-input-major);overflow:hidden;font-size:13px}.dsh-policy-review-strip{padding:10px 16px;background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary)}.dsh-policy-review-body{padding:12px 16px;max-height:var(--dsh-composer-text-max-height,300px);overflow:auto;overflow-wrap:anywhere}.dsh-policy-review-body p{margin:8px 0;color:var(--dsw-alias-label-secondary)}.dsh-policy-review-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;padding:8px 16px 14px}`
