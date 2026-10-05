import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-goal/client'
import {
  configurationModel,
  configurationStatus,
  configurationTheme,
  privateStateClient,
  registerConfiguration,
  registerConversationPanel,
} from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h, useEffect, useRef, useState } from 'react'
import { assuranceSchema } from '../view.ts'
export const inject = [
  'slots',
  'locale',
  'configForms',
  'settingsSchema',
  'remote',
  'remote.commands',
  'sessions',
]
export function apply(ctx: Context): void {
  const useEvidence = privateStateClient(ctx, 'evidenceAssurance', (value) =>
    assuranceSchema.parse(value),
  )
  const Status = configurationStatus(ctx, 'assurance'),
    Model = configurationModel(ctx, {
      providerField: 'verifierProvider',
      modelField: 'verifierModel',
      title: 'Independent verifier model',
      description:
        'Choose any registered text model. Its provider owns the credential. Model validation is separate from generation and cannot replace deterministic checks or human review.',
    })
  function Introduction() {
    return h(
      'section',
      null,
      h(Status),
      h('h3', null, 'An answer is a proposal'),
      h(
        'p',
        null,
        'Verified means the declared evidence contract passed for the exact workspace and current criteria. Unverified means there is no grounded verification contract. Insufficient evidence lists missing or stale requirements. A model verdict alone never certifies consequential work.',
      ),
      h(
        'p',
        null,
        '/workflow start CONTRACT :: CRITERIA declares a completion contract. /assurance verify CONTRACT runs only configured recipes. /assurance approve TARGET_HASH records human review of the exact target. /workflow complete checks the contract before recording completion.',
      ),
    )
  }
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-evidence-assurance',
    rowId: 'evidence-assurance',
    before: Introduction,
    sections: [{ fields: ['verifierProvider', 'verifierModel'], component: Model }],
  })
  function Evidence(props: PropsRuntime<'conversation.input.left'>) {
    const projection = useEvidence(props.sessionId)
    const goal = props.useProjection('goal')
    const open = true
    const [busy, setBusy] = useState(false),
      [verdict, setVerdict] = useState<{ target: string; state: string; missing: string[] }>(),
      [message, setMessage] = useState(''),
      [criteria, setCriteria] = useState(''),
      [contract, setContract] = useState('goal-completion')
    const epoch = useRef(0),
      pending = useRef(false)
    // biome-ignore lint/correctness/useExhaustiveDependencies: Reset verdicts and fence pending operations whenever the reviewed target changes.
    useEffect(() => {
      epoch.current++
      pending.current = false
      setBusy(false)
      setVerdict(undefined)
      setMessage('')
      return () => {
        epoch.current++
      }
    }, [
      props.sessionId,
      goal?.goal.id,
      goal?.goal.revision,
      projection?.candidate?.hash,
      projection?.workflow?.revision,
    ])
    const run = async (command: string) => {
      if (pending.current) return
      pending.current = true
      const generation = ++epoch.current
      setBusy(true)
      setMessage('')
      try {
        const result = await ctx.remote.commands.execute(props.sessionId, command, [])
        if (generation !== epoch.current) return
        if (!result.ok) throw new Error(result.error.message)
        if (!result.value) throw new Error('Enable Evidence Assurance on the host.')
        const response = result.value.result
        if (response.kind === 'error') throw new Error(response.text)
        try {
          const value = JSON.parse(response.text ?? '{}')
          if (value.target && value.state) setVerdict(value)
          else setMessage(response.text ?? 'Updated.')
        } catch {
          setMessage(response.text ?? 'Updated.')
        }
      } catch (error) {
        if (generation === epoch.current)
          setMessage(error instanceof Error ? error.message : 'Evidence request failed.')
      } finally {
        if (generation === epoch.current) {
          pending.current = false
          setBusy(false)
        }
      }
    }
    return h(
      'div',
      {
        className: 'dsh-plugin-settings dsh-plugin-panel',
        onKeyDown: (event: React.KeyboardEvent) => {
          if (
            event.key === 'Enter' &&
            ['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement).tagName)
          ) {
            event.stopPropagation()
            if ((event.target as HTMLElement).tagName === 'INPUT' && !event.nativeEvent.isComposing)
              event.preventDefault()
          }
        },
      },
      h('style', null, configurationTheme),
      h(
        'p',
        { className: 'config-status' },
        verdict ? `Evidence · ${verdict.state.replaceAll('_', ' ')}` : 'Evidence & completion',
      ),
      open
        ? h(
            'section',
            { 'aria-label': 'Evidence and completion' },
            h(
              'p',
              null,
              'Model output is unverified until its declared checks pass. Completion rechecks the current workspace and criteria; a previous verdict can become stale.',
            ),
            projection?.workflow?.criteria || goal?.goal.objective
              ? h('p', null, `Criteria: ${projection?.workflow?.criteria ?? goal?.goal.objective}`)
              : null,
            h(
              Button,
              {
                variant: 'outline',
                size: 'sm',
                type: 'button',
                disabled: busy,
                onClick: () => {
                  void run('/assurance status')
                },
              },
              'Check evidence',
            ),
            h(
              Button,
              {
                variant: 'outline',
                size: 'sm',
                type: 'button',
                disabled: busy,
                onClick: () => {
                  void run(`/assurance verify ${projection?.workflow?.contract ?? contract}`)
                },
              },
              'Run configured verifiers',
            ),
            verdict
              ? h(
                  'div',
                  null,
                  h(
                    'p',
                    null,
                    `Last checked target ${verdict.target.slice(0, 12)} · ${verdict.state}`,
                  ),
                  verdict.missing.length
                    ? h('ul', null, ...verdict.missing.map((item) => h('li', { key: item }, item)))
                    : null,
                  h(
                    Button,
                    {
                      variant: 'outline',
                      size: 'sm',
                      type: 'button',
                      disabled: busy,
                      onClick: () => {
                        void run(`/assurance approve ${verdict.target}`)
                      },
                    },
                    'Attest review of this target',
                  ),
                )
              : null,
            projection?.workflow
              ? h(
                  'div',
                  null,
                  h('h3', null, `Workflow · ${projection.workflow.phase}`),
                  h('p', null, projection.workflow.criteria),
                  h(
                    Button,
                    {
                      variant: 'outline',
                      size: 'sm',
                      type: 'button',
                      disabled: busy || projection.workflow.phase === 'complete',
                      onClick: () => {
                        void run('/workflow complete')
                      },
                    },
                    'Check and complete workflow',
                  ),
                )
              : h(
                  'div',
                  null,
                  h(
                    'label',
                    null,
                    'Evidence contract',
                    h(Input, {
                      className: 'config-input',
                      value: contract,
                      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                        setContract(event.target.value),
                    }),
                  ),
                  h(
                    'label',
                    null,
                    'Explicit completion criteria',
                    h('textarea', {
                      value: criteria,
                      rows: 3,
                      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
                        setCriteria(event.target.value),
                    }),
                  ),
                  h(
                    Button,
                    {
                      variant: 'outline',
                      size: 'sm',
                      type: 'button',
                      disabled: busy || !criteria.trim() || !contract.trim(),
                      onClick: () => {
                        void run(`/workflow start ${contract} :: ${criteria}`)
                      },
                    },
                    'Declare workflow criteria',
                  ),
                ),
            projection?.receipts.length
              ? h(
                  'details',
                  null,
                  h('summary', null, `${projection.receipts.length} recent evidence receipts`),
                  h(
                    'ul',
                    null,
                    ...projection.receipts
                      .toReversed()
                      .slice(0, 16)
                      .map((receipt) =>
                        h(
                          'li',
                          { key: receipt.id },
                          `${receipt.kind} · ${receipt.passed ? 'pass' : 'failed'} · ${receipt.origin} · target ${receipt.target.slice(0, 12)}`,
                        ),
                      ),
                  ),
                )
              : null,
            message ? h('p', { role: 'status' }, message) : null,
          )
        : null,
    )
  }
  registerConversationPanel(ctx, {
    id: 'evidence-assurance',
    label: 'Evidence & completion',
    order: 18,
    component: Evidence,
  })
}
