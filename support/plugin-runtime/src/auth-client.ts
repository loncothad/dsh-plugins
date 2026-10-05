import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { type AuthNamespace, type AuthView, authContribution, parseAuthView } from './auth-wire.ts'
import { subscriptionControls } from './quota-client.ts'
import { connectRemote, remoteValue } from './remote-client.ts'
export function accountStatus(ctx: Context, namespace: AuthNamespace): React.ComponentType {
  const mount = connectRemote(ctx, namespace, authContribution(namespace))
  return function Accounts() {
    const [message, setMessage] = useState('Loading subscription account…')
    useEffect(() => {
      let live = true
      void mount()
        .then((remote) => remote.state())
        .then((result) => {
          const active = parseAuthView(remoteValue(result)).accounts?.find(
            (account) => account.active,
          )
          if (live)
            setMessage(
              active
                ? `Active account: ${active.label}`
                : 'No active subscription account. Sign in in Plugins > ChatGPT Codex.',
            )
        })
        .catch(() => {
          if (live) setMessage('Enable ChatGPT Codex to use subscription search.')
        })
      return () => {
        live = false
      }
    }, [])
    return h('p', { role: 'status' }, message)
  }
}

/** Login interactions carry notices and temporary prompts; grants stay on the Host. */
export function authenticationControls(
  ctx: Context,
  namespace: AuthNamespace,
): React.ComponentType {
  const mount = connectRemote(ctx, namespace, authContribution(namespace))
  const Quota = subscriptionControls(mount)
  function Login() {
    const inputId = useId(),
      detachedForm = `${inputId}-login-owner`
    const operationEpoch = useRef(0),
      running = useRef(false)
    const [view, setView] = useState<AuthView>()
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [answer, setAnswer] = useState('')
    const [refresh, setRefresh] = useState(0)
    // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh restarts polling after an account operation.
    useEffect(() => {
      let stopped = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const read = async () => {
        if (running.current) return
        const epoch = operationEpoch.current
        try {
          const remote = await mount()
          const state = parseAuthView(remoteValue(await remote.state()))
          if (stopped || epoch !== operationEpoch.current) return
          setView(state)
          setError('')
          if (state.attempt?.status === 'running')
            timer = setTimeout(() => {
              void read()
            }, 1000)
        } catch {
          if (!stopped && epoch === operationEpoch.current)
            setError('Login service is unavailable. Enable the provider and reconnect.')
        }
      }
      void read()
      return () => {
        stopped = true
        if (timer) clearTimeout(timer)
      }
    }, [refresh])
    // biome-ignore lint/correctness/useExhaustiveDependencies: A new authorization prompt must clear the previous answer.
    useEffect(() => {
      setAnswer('')
    }, [view?.attempt?.prompt?.id])
    const run = async (operation: () => Promise<RemoteResult<AuthView>>) => {
      if (running.current) return
      running.current = true
      operationEpoch.current++
      setBusy(true)
      setError('')
      try {
        setView(parseAuthView(remoteValue(await operation())))
        setAnswer('')
        setRefresh((value) => value + 1)
      } catch {
        setError('Login operation failed. Refresh the login state and try again.')
      } finally {
        running.current = false
        setBusy(false)
      }
    }
    const attempt = view?.attempt
    const prompt = attempt?.prompt
    const submitAnswer = () => {
      if (attempt && prompt && answer && !running.current)
        void run(() => mount().then((remote) => remote.answer(attempt.id, prompt.id, answer)))
    }
    return h(
      'section',
      null,
      h('h3', null, namespace === 'codexAuth' ? 'Sign in to ChatGPT Codex' : 'Sign in to Z.AI'),
      h(
        'p',
        null,
        namespace === 'codexAuth'
          ? 'Device login works when Harness runs on another machine. Browser login requires access to the Host’s localhost callback.'
          : 'Sign in through ZCode, or enter an existing Z.AI coding-plan API key.',
      ),
      h(
        'div',
        { className: 'config-auth-methods' },
        ...[...(view?.methods ?? [])]
          .sort((a, b) => Number(b.id === 'device') - Number(a.id === 'device'))
          .map((method) =>
            h(
              Button,
              {
                variant: 'outline',
                size: 'sm',
                key: method.id,
                type: 'button',
                disabled: busy || attempt?.status === 'running',
                onClick: () => {
                  void run(() => mount().then((remote) => remote.begin(method.id)))
                },
              },
              method.label,
            ),
          ),
      ),
      attempt?.notice
        ? h(
            'div',
            { className: 'config-note', role: 'status' },
            h('p', null, attempt.notice.message),
            attempt.notice.url
              ? h(
                  'a',
                  { href: attempt.notice.url, target: '_blank', rel: 'noreferrer' },
                  'Open sign-in page',
                )
              : null,
            attempt.notice.code ? h('p', null, h('strong', null, attempt.notice.code)) : null,
          )
        : null,
      prompt
        ? h(
            'div',
            null,
            h('label', { htmlFor: inputId }, prompt.message),
            prompt.kind === 'select'
              ? h(
                  'select',
                  {
                    id: inputId,
                    form: detachedForm,
                    value: answer,
                    disabled: busy,
                    onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
                      setAnswer(event.target.value),
                  },
                  h('option', { value: '' }, 'Choose…'),
                  ...(prompt.options ?? []).map((option) =>
                    h('option', { key: option.id, value: option.id }, option.label),
                  ),
                )
              : h(Input, {
                  className: 'config-input',
                  id: inputId,
                  form: detachedForm,
                  type: prompt.kind === 'secret' ? 'password' : 'text',
                  autoComplete: 'off',
                  value: answer,
                  disabled: busy,
                  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      event.stopPropagation()
                      submitAnswer()
                    }
                  },
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                    setAnswer(event.target.value),
                }),
            h(
              Button,
              {
                variant: 'outline',
                size: 'sm',
                type: 'button',
                disabled: busy || !answer,
                onClick: submitAnswer,
              },
              'Continue',
            ),
          )
        : null,
      attempt?.status === 'running'
        ? h(
            Button,
            {
              variant: 'outline',
              size: 'sm',
              type: 'button',
              disabled: busy,
              onClick: () => {
                void run(() => mount().then((remote) => remote.cancel(attempt.id)))
              },
            },
            'Cancel login',
          )
        : null,
      attempt?.status === 'authorized'
        ? h('p', { role: 'status' }, 'Signed in. The credential is stored on the Harness host.')
        : null,
      view?.accounts?.length
        ? h(
            'section',
            { className: 'config-accounts', 'aria-label': 'Signed-in accounts' },
            h('h4', null, 'Signed-in accounts'),
            ...view.accounts.map((account) =>
              h(
                'div',
                { key: account.name, className: 'config-account' },
                h('span', null, account.label, account.active ? ' · Active' : ''),
                !account.active
                  ? h(
                      Button,
                      {
                        variant: 'outline',
                        size: 'sm',
                        type: 'button',
                        disabled: busy,
                        onClick: () => {
                          void run(() =>
                            mount().then((remote) => remote.selectAccount(account.name)),
                          )
                        },
                      },
                      'Use this account',
                    )
                  : null,
                h(
                  Button,
                  {
                    variant: 'outline',
                    size: 'sm',
                    type: 'button',
                    disabled: busy,
                    onClick: () => {
                      void run(() => mount().then((remote) => remote.removeAccount(account.name)))
                    },
                  },
                  'Sign out',
                ),
                h(Quota, { name: account.name }),
              ),
            ),
          )
        : null,
      error ? h('p', { role: 'alert' }, error) : null,
      h(
        Button,
        {
          variant: 'outline',
          size: 'sm',
          type: 'button',
          disabled: busy,
          onClick: () => {
            if (!running.current) setRefresh((value) => value + 1)
          },
        },
        'Refresh login state',
      ),
    )
  }
  return Login
}
