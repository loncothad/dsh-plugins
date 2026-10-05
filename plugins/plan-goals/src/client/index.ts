import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-goal/client'
import {
  configurationModel,
  configurationTheme,
  privateStateClient,
  registerConfiguration,
  registerConversationPanel,
} from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h, useRef, useState, useSyncExternalStore } from 'react'
import { planSchema } from '../domain.ts'
import { registerAuditFeedback } from './audit-feedback.ts'
import { registerPlanningMessages } from './planning-message.ts'
import { goalProgress } from './progress.ts'
import { goalReview } from './review.ts'
export const inject = [
  'slots',
  'locale',
  'configForms',
  'settingsSchema',
  'sessions',
  'remote',
  'remote.commands',
  'remote.session',
]
export function apply(ctx: Context): void {
  registerAuditFeedback(ctx)
  registerPlanningMessages(ctx)
  const usePlan = privateStateClient(ctx, 'sisyphus', (value) => planSchema.nullable().parse(value))
  const nativeDefaults = ctx.configForms.get<Record<string, unknown>>('goal')
  function NativeGoalDefaults() {
    const state = useSyncExternalStore(
      (listener) => nativeDefaults.subscribe(listener),
      () => nativeDefaults.getSnapshot(),
    )
    const [draft, setDraft] = useState(''),
      [busy, setBusy] = useState(false),
      [message, setMessage] = useState('')
    const save = async () => {
      const rounds = Number(draft)
      if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10000) {
        setMessage('Choose 1–10000 automatic rounds.')
        return
      }
      setBusy(true)
      try {
        const accepted = await nativeDefaults.mutate(
          [{ op: 'set', path: ['defaultMaxGoalRounds'], value: rounds }],
          state.revision,
        )
        setMessage(
          accepted
            ? 'Native goal defaults saved.'
            : 'Goal defaults changed elsewhere. Reload before saving.',
        )
        if (accepted) setDraft('')
      } catch {
        setMessage('The native goal defaults could not be saved.')
      } finally {
        setBusy(false)
      }
    }
    if (state.status !== 'ready')
      return h(
        'p',
        { role: 'status' },
        'Native goal defaults are unavailable in this profile. Existing goals can edit their own round limit in the conversation.',
      )
    return h(
      'div',
      { className: 'config-field' },
      h(
        'label',
        null,
        'Default regular goal rounds',
        h(Input, {
          className: 'config-input',
          type: 'number',
          min: 1,
          max: 10000,
          value: draft || String(state.value?.defaultMaxGoalRounds ?? ''),
          disabled: busy || !state.writable,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
          style: { width: '100%' },
        }),
      ),
      h(
        'p',
        null,
        'This edits DSH’s native creation default. Explicit per-goal limits remain authoritative. Save this default separately from the ordered-goal policy below.',
      ),
      h(
        Button,
        {
          variant: 'outline',
          size: 'sm',
          type: 'button',
          disabled: busy || !state.writable || !draft,
          onClick: () => {
            void save()
          },
        },
        'Save native goal defaults',
      ),
      message ? h('p', { role: 'status' }, message) : null,
    )
  }
  function Introduction() {
    return h(
      'section',
      null,
      h(NativeGoalDefaults),
      h('h3', null, 'Choose how to work'),
      h(
        'p',
        null,
        'Plan mode explores the task and presents a plan for review. Regular goals adapt their approach to the outcome. Sisyphus goals execute an ordered sequence with an acceptance check at each step.',
      ),
      h(
        'table',
        null,
        h(
          'tbody',
          null,
          ...[
            ['/plan', 'Explore and review a plan before implementation.'],
            ['/goal Outcome', 'Pursue an outcome and adapt the plan.'],
            ['/sisyphus', 'Create an ordered goal in the conversation panel.'],
          ].map(([command, detail]) =>
            h('tr', { key: command }, h('th', { scope: 'row' }, command), h('td', null, detail)),
          ),
        ),
      ),
    )
  }
  const Auditor = configurationModel(ctx, {
    providerField: 'auditorProvider',
    modelField: 'auditorModel',
    title: 'Completion auditor',
    description:
      'Select a model separate from generation. The auditor checks criteria against supplied evidence before completion.',
  })
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-plan-goals',
    rowId: 'plan-goals',
    before: Introduction,
    sections: [{ fields: ['auditorProvider', 'auditorModel'], component: Auditor }],
  })
  const Progress = goalProgress(ctx)
  const InlineProgress = goalProgress(ctx, true)
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      { name: 'conversation.input.dock', id: 'plan-goals-progress', order: 20 },
      InlineProgress,
    ),
  )
  const Review = goalReview(ctx)
  function Dock(props: PropsRuntime<'conversation.input.left'>) {
    const plan = usePlan(props.sessionId)
    const goal = props.useProjection('goal')
    const current = plan && goal?.goal.id === plan.goalId ? plan : undefined
    const [editing, setEditing] = useState(false),
      open = true,
      [title, setTitle] = useState(''),
      [steps, setSteps] = useState(''),
      [evidence, setEvidence] = useState(''),
      [roundLimit, setRoundLimit] = useState(''),
      [busy, setBusy] = useState(false),
      [error, setError] = useState('')
    const pending = useRef(false)
    const run = async (command: string) => {
      if (pending.current) return
      pending.current = true
      setBusy(true)
      setError('')
      try {
        const result = await ctx.remote.commands.execute(props.sessionId, command, [])
        if (!result.ok) throw new Error(result.error.message)
        if (!result.value) throw new Error('Enable Plan & Goals on the Host')
        if (result.value.result.kind === 'error') throw new Error(result.value.result.text)
        setEvidence('')
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Could not update the ordered goal')
      } finally {
        pending.current = false
        setBusy(false)
      }
    }
    return h(
      'div',
      {
        className: 'dsh-plugin-settings dsh-plugin-panel',
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key === 'Enter') {
            const tag = (event.target as HTMLElement).tagName
            if (tag === 'INPUT' || tag === 'TEXTAREA') {
              event.stopPropagation()
              if (tag === 'INPUT' && !event.nativeEvent.isComposing) event.preventDefault()
            }
          }
        },
      },
      h('style', null, configurationTheme),
      h(Progress, props),
      h(Review, props),
      h(
        'p',
        { className: 'config-status' },
        current
          ? `Sisyphus · ${current.phase} · ${Math.min(current.index + 1, current.steps.length)}/${current.steps.length}`
          : 'Sisyphus goal',
      ),
      !current && goal
        ? h(
            'div',
            null,
            h(
              'label',
              null,
              `Regular goal rounds · ${goal.roundsStarted}/${goal.goal.maxGoalRounds}`,
              h(Input, {
                className: 'config-input',
                type: 'number',
                min: 1,
                max: 10000,
                value: roundLimit || String(goal.goal.maxGoalRounds),
                disabled: busy,
                onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                  setRoundLimit(event.target.value),
              }),
            ),
            h(
              Button,
              {
                variant: 'outline',
                size: 'sm',
                type: 'button',
                disabled: busy || !roundLimit,
                onClick: () => {
                  void run(`/goal-rounds ${goal.goal.id} ${goal.goal.revision} ${roundLimit}`)
                  setRoundLimit('')
                },
              },
              'Save goal round limit',
            ),
          )
        : null,
      open
        ? h(
            'section',
            { 'aria-label': 'Ordered goal' },
            current
              ? h(
                  'div',
                  null,
                  h('h3', null, current.title),
                  current.notice ? h('p', { role: 'status' }, current.notice) : null,
                  h(
                    'ol',
                    null,
                    ...current.steps.map((step, index) =>
                      h(
                        'li',
                        {
                          key: index,
                          'aria-current': index === current.index ? 'step' : undefined,
                        },
                        h('strong', null, step.title),
                        h('p', null, step.acceptance),
                        step.evidence ? h('p', null, `Evidence: ${step.evidence}`) : null,
                      ),
                    ),
                  ),
                  (current.phase === 'active' && goal?.goal.phase === 'active') ||
                    current.phase === 'review'
                    ? h(
                        'div',
                        null,
                        h(
                          'label',
                          null,
                          'Completion evidence',
                          h(Input, {
                            className: 'config-input',
                            value: evidence || current.pendingEvidence || '',
                            disabled: busy,
                            maxLength: 8192,
                            onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                              setEvidence(event.target.value),
                            style: { width: '100%' },
                          }),
                        ),
                        h(
                          Button,
                          {
                            variant: 'outline',
                            size: 'sm',
                            type: 'button',
                            disabled: busy || !(evidence || current.pendingEvidence || '').trim(),
                            onClick: () => {
                              void run(
                                `/sisyphus approve ${current.revision} ${evidence || current.pendingEvidence || ''}`,
                              )
                            },
                          },
                          'Approve current step',
                        ),
                        h(
                          Button,
                          {
                            variant: 'outline',
                            size: 'sm',
                            type: 'button',
                            disabled: busy,
                            onClick: () => {
                              void run(
                                current.phase === 'review' ? '/sisyphus resume' : '/sisyphus pause',
                              )
                            },
                          },
                          current.phase === 'review' ? 'Continue working on this step' : 'Pause',
                        ),
                      )
                    : current.phase !== 'complete' && goal?.goal.phase !== 'complete'
                      ? h(
                          Button,
                          {
                            variant: 'outline',
                            size: 'sm',
                            type: 'button',
                            disabled: busy,
                            onClick: () => {
                              void run('/sisyphus resume')
                            },
                          },
                          'Resume',
                        )
                      : null,
                  current.phase !== 'complete' && goal?.goal.phase !== 'complete'
                    ? h(
                        Button,
                        {
                          variant: 'outline',
                          size: 'sm',
                          type: 'button',
                          disabled: busy,
                          onClick: () => {
                            setEditing(!editing)
                            setTitle(current.title)
                            setSteps(
                              current.steps
                                .slice(current.index)
                                .map((step) => `${step.title} | ${step.acceptance}`)
                                .join('\n'),
                            )
                          },
                        },
                        'Revise remaining steps',
                      )
                    : null,
                  editing
                    ? h(
                        'div',
                        null,
                        h(
                          'label',
                          null,
                          'Revised outcome',
                          h(Input, {
                            className: 'config-input',
                            value: title,
                            onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                              setTitle(event.target.value),
                          }),
                        ),
                        h(
                          'label',
                          null,
                          'Remaining steps and acceptance checks',
                          h('textarea', {
                            value: steps,
                            rows: 4,
                            onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
                              setSteps(event.target.value),
                          }),
                        ),
                        h(
                          'p',
                          null,
                          'Completed steps and their evidence are preserved. Saving pauses continuation until you resume.',
                        ),
                        h(
                          Button,
                          {
                            variant: 'outline',
                            size: 'sm',
                            type: 'button',
                            disabled: busy || !title.trim() || !steps.trim(),
                            onClick: () => {
                              void run(`/sisyphus amend ${current.revision} ${title} :: ${steps}`)
                              setEditing(false)
                            },
                          },
                          'Save revised plan',
                        ),
                      )
                    : null,
                  h(
                    'label',
                    null,
                    'Total round limit',
                    h(Input, {
                      className: 'config-input',
                      type: 'number',
                      min: 1,
                      max: 10000,
                      value: roundLimit || String(goal?.goal.maxGoalRounds ?? ''),
                      disabled: busy,
                      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                        setRoundLimit(event.target.value),
                    }),
                  ),
                  h(
                    Button,
                    {
                      variant: 'outline',
                      size: 'sm',
                      type: 'button',
                      disabled: busy || !roundLimit,
                      onClick: () => {
                        void run(`/sisyphus budget ${current.revision} ${roundLimit}`)
                        setRoundLimit('')
                      },
                    },
                    'Save round limit',
                  ),
                  h(
                    Button,
                    {
                      variant: 'outline',
                      size: 'sm',
                      type: 'button',
                      disabled: busy,
                      onClick: () => {
                        void run('/sisyphus clear')
                      },
                    },
                    'Clear ordered goal',
                  ),
                )
              : h(
                  'div',
                  null,
                  h(
                    'label',
                    null,
                    'Outcome',
                    h(Input, {
                      className: 'config-input',
                      value: title,
                      disabled: busy,
                      maxLength: 4096,
                      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                        setTitle(event.target.value),
                      style: { width: '100%' },
                    }),
                  ),
                  h(
                    'label',
                    null,
                    'Steps and acceptance checks',
                    h('textarea', {
                      value: steps,
                      disabled: busy,
                      rows: 4,
                      placeholder:
                        'Inspect dependencies | Record the current dependency versions\nUpdate the code | Tests pass with the new versions',
                      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
                        setSteps(event.target.value),
                    }),
                  ),
                  h(
                    'p',
                    null,
                    'One step per line. Separate the step title from its acceptance criterion with |. Starting authorizes work on the first step; later steps follow the configured checkpoint policy.',
                  ),
                  h(
                    Button,
                    {
                      variant: 'outline',
                      size: 'sm',
                      type: 'button',
                      disabled: busy || !title.trim() || !steps.trim(),
                      onClick: () => {
                        void run(
                          `/sisyphus-direct ${JSON.stringify({
                            title,
                            steps: steps
                              .split('\n')
                              .filter((line) => line.trim())
                              .map((line) => {
                                const [name, ...parts] = line.split('|')
                                return { title: name!.trim(), acceptance: parts.join('|').trim() }
                              }),
                          })}`,
                        )
                      },
                    },
                    'Start ordered goal',
                  ),
                ),
            error ? h('p', { role: 'alert' }, error) : null,
          )
        : null,
    )
  }
  registerConversationPanel(ctx, {
    id: 'plan-goals',
    label: 'Plan & goals',
    order: 15,
    component: Dock,
  })
}
