import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createElement as h, useEffect, useRef, useState } from 'react'
import type { AuthRemote } from './auth-wire.ts'
import { quotaWindowTitle, remainingQuota, renewalCountdown } from './quota-presentation.ts'
import { parseSubscriptionQuota, type SubscriptionQuota } from './quota-wire.ts'
import { remoteValue } from './remote-client.ts'

export function subscriptionControls(mount: () => Promise<AuthRemote>) {
  let queue = Promise.resolve()
  return function Quota({ name }: { name: string }) {
    const [view, setView] = useState<SubscriptionQuota>(),
      [error, setError] = useState(''),
      [busy, setBusy] = useState(false),
      [confirm, setConfirm] = useState<{ id: string; requestId: string }>(),
      [now, setNow] = useState(Date.now)
    const live = useRef(false),
      epoch = useRef(0),
      running = useRef(false)
    const apply = async (operation: () => Promise<RemoteResult<SubscriptionQuota>>) => {
      if (running.current) return
      running.current = true
      const generation = ++epoch.current
      setBusy(true)
      setError('')
      try {
        const result = parseSubscriptionQuota(remoteValue(await operation()))
        if (live.current && generation === epoch.current) {
          setView(result)
          setConfirm(undefined)
        }
      } catch {
        if (live.current && generation === epoch.current)
          setError(
            'Could not update subscription status. Refresh or sign in again. A failed reset can be retried with the same request ID.',
          )
      } finally {
        running.current = false
        if (live.current && generation === epoch.current) setBusy(false)
      }
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: Account identity owns the initial check; apply uses only stable setters and refs.
    useEffect(() => {
      live.current = true
      queue = queue.then(async () => {
        if (live.current) await apply(async () => (await mount()).quota(name))
      })
      return () => {
        live.current = false
        epoch.current++
      }
    }, [name])
    useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), 30000)
      return () => clearInterval(timer)
    }, [])
    const timestamp = (value: number) =>
      new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    return h(
      'section',
      { className: 'config-subscription', 'aria-label': `Subscription quota for ${name}` },
      h(
        'div',
        { className: 'config-quota-heading' },
        h(
          'strong',
          null,
          view
            ? /^[a-z_]+$/.test(view.plan)
              ? view.plan.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
              : view.plan
            : busy
              ? 'Loading subscription…'
              : 'Subscription unknown',
        ),
        h(
          Button,
          {
            type: 'button',
            size: 'sm',
            variant: 'ghost',
            disabled: busy,
            onClick: () => void apply(async () => (await mount()).quota(name)),
          },
          busy ? 'Refreshing…' : 'Refresh quota',
        ),
      ),
      view
        ? h(
            'div',
            null,
            h(
              'div',
              { className: 'config-quota-grid' },
              ...view.windows.map((window, index) => {
                const remaining = remainingQuota(window)
                return h(
                  'article',
                  {
                    key: index,
                    className: 'config-quota-window',
                    'aria-label': quotaWindowTitle(window),
                  },
                  h(
                    'div',
                    { className: 'config-quota-heading' },
                    h('span', null, quotaWindowTitle(window)),
                    h(
                      'strong',
                      null,
                      remaining.percent === undefined
                        ? 'Unknown'
                        : `${remaining.percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}% left`,
                    ),
                  ),
                  remaining.percent === undefined
                    ? null
                    : h('progress', {
                        max: 100,
                        value: remaining.percent,
                        'aria-label': `${quotaWindowTitle(window)} remaining allowance`,
                      }),
                  remaining.amount === undefined
                    ? null
                    : h(
                        'p',
                        null,
                        `${remaining.amount.toLocaleString()}${window.limit === undefined ? '' : ` / ${window.limit.toLocaleString()}`} remaining`,
                      ),
                  h(
                    'p',
                    { className: 'config-quota-renewal' },
                    window.resetsAt === undefined
                      ? 'Renewal time unknown'
                      : renewalCountdown(window.resetsAt, now),
                  ),
                  window.resetsAt === undefined
                    ? null
                    : h('small', null, `Renews ${timestamp(window.resetsAt)}`),
                )
              }),
            ),
            view.windows.length ? null : h('p', null, 'Quota windows unknown.'),
            h(
              'section',
              { className: 'config-quota-resets', 'aria-label': 'Subscription resets' },
              h(
                'div',
                { className: 'config-quota-heading' },
                h('h5', null, 'Usage resets'),
                h('small', null, view.resetStatus),
              ),
              ...view.resets.map((reset, index) =>
                h(
                  'div',
                  { key: reset.id, className: 'config-reset-row' },
                  h(
                    'div',
                    null,
                    h(
                      'strong',
                      null,
                      reset.label,
                      view.resets.some((other, i) => i !== index && other.label === reset.label)
                        ? ` #${index + 1}`
                        : '',
                    ),
                    h('small', null, reset.count ? `${reset.count} available` : 'Available'),
                    h(
                      'small',
                      null,
                      reset.expiresAt === undefined
                        ? 'Expiry not reported'
                        : `Expires ${timestamp(reset.expiresAt)}`,
                    ),
                  ),
                  h(
                    Button,
                    {
                      type: 'button',
                      size: 'sm',
                      variant: 'outline',
                      disabled: busy || (reset.expiresAt !== undefined && reset.expiresAt <= now),
                      onClick: () => setConfirm({ id: reset.id, requestId: crypto.randomUUID() }),
                    },
                    'Use reset',
                  ),
                ),
              ),
              view.resetHistory?.length
                ? h(
                    'details',
                    null,
                    h('summary', null, `Previous resets (${view.resetHistory.length})`),
                    ...view.resetHistory.map((reset, index) =>
                      h(
                        'div',
                        { key: index, className: 'config-reset-row' },
                        h(
                          'div',
                          null,
                          h('strong', null, reset.label),
                          h('small', null, reset.status),
                          reset.usedAt === undefined
                            ? null
                            : h('small', null, `Used ${timestamp(reset.usedAt)}`),
                          reset.expiresAt === undefined
                            ? null
                            : h('small', null, `Expiry ${timestamp(reset.expiresAt)}`),
                        ),
                      ),
                    ),
                  )
                : null,
            ),
            h(
              'small',
              { className: 'config-quota-checked' },
              `Last checked ${timestamp(view.observedAt)}`,
            ),
            view.notice ? h('p', { role: 'status' }, view.notice) : null,
          )
        : null,
      confirm
        ? h(
            'div',
            { role: 'group', 'aria-label': 'Confirm subscription reset' },
            h(
              'p',
              null,
              `Use one subscription reset for ${name}? This consumes the selected reset entitlement.`,
            ),
            h(
              Button,
              {
                type: 'button',
                size: 'sm',
                variant: 'primary',
                disabled: busy,
                onClick: () =>
                  void apply(async () =>
                    (await mount()).resetQuota(name, confirm.id, confirm.requestId),
                  ),
              },
              'Confirm quota reset',
            ),
            h(
              Button,
              {
                type: 'button',
                size: 'sm',
                variant: 'ghost',
                disabled: busy,
                onClick: () => setConfirm(undefined),
              },
              'Cancel reset',
            ),
          )
        : null,
      error ? h('p', { role: 'alert' }, error) : null,
    )
  }
}
