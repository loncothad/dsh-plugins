import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button, Checkbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  modelRoutePicker,
  openConversationPanel,
  privateStateClient,
  privateStateObservation,
} from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { planSchema } from '../domain.ts'
import { type GoalSettings, goalBookSchema } from '../goal-book.ts'
import { taskState } from '../task-contract.ts'
import { progressPresentation } from './progress-state.ts'
export function goalProgress(ctx: Context, inline = false) {
  const useBook = privateStateObservation(ctx, 'goalBook', (value) => goalBookSchema.parse(value)),
    usePlan = privateStateClient(ctx, 'sisyphus', (v) => planSchema.nullable().parse(v)),
    Route = modelRoutePicker(ctx),
    defaults = ctx.configForms.get<Record<string, unknown>>('plan-goals')
  return function Progress(props: PropsRuntime<'conversation.input.left'>) {
    const configured = useSyncExternalStore(
      (listener) => defaults.subscribe(listener),
      () => defaults.getSnapshot(),
    )
    const base: GoalSettings = {
      auditMode: configured.value?.auditMode as GoalSettings['auditMode'],
      completionMode: configured.value?.completionMode as GoalSettings['completionMode'],
      auditorProvider: configured.value?.auditorProvider as string,
      auditorModel: configured.value?.auditorModel as string,
      auditorEffort: configured.value?.auditorEffort as string,
      showProgress: configured.value?.showProgress as boolean,
      compactAfterTask: configured.value?.compactAfterTask as boolean,
    }
    const observed = useBook(props.sessionId),
      book = observed.value,
      plan = usePlan(props.sessionId),
      native = props.useProjection('goal'),
      goal = book?.goals.find((g) => g.id === (book.draft ?? book.focused)),
      settings = { ...base, ...book?.settings, ...goal?.settings }
    const [busy, setBusy] = useState(false),
      [error, setError] = useState(''),
      [editing, setEditing] = useState(false),
      [draft, setDraft] = useState<GoalSettings>()
    const session = useRef(props.sessionId)
    session.current = props.sessionId
    useEffect(() => {
      session.current = props.sessionId
      setBusy(false)
      setError('')
      setEditing(false)
      setDraft(undefined)
    }, [props.sessionId])
    const run = async (command: string) => {
      const id = props.sessionId
      setBusy(true)
      setError('')
      try {
        const r = await ctx.remote.commands.execute(id, command, [])
        if (!r.ok) throw Error(r.error.message)
        if (!r.value || r.value.result.kind === 'error')
          throw Error(r.value?.result.text ?? 'Goal command unavailable')
      } catch (e) {
        if (session.current === id) setError(e instanceof Error ? e.message : 'Goal update failed')
      } finally {
        if (session.current === id) setBusy(false)
      }
    }
    const save = (value: GoalSettings) =>
      run(`/goal-settings ${JSON.stringify({ revision: book?.revision ?? 0, settings: value })}`)
    const view = progressPresentation(goal, plan, native?.goal)
    if (inline && (!view || settings.showProgress === false)) return null
    const progress = view
      ? h(
          'div',
          {
            className: inline ? 'dsh-goal-progress-shell' : 'dsh-goal-progress-panel',
            'aria-label': 'Current goal progress',
          },
          h('style', null, goalProgressTheme),
          h(
            'details',
            { className: 'dsh-goal-progress' },
            h(
              'summary',
              { className: 'dsh-goal-progress-summary' },
              h('span', { className: 'dsh-goal-progress-chevron', 'aria-hidden': true }, '›'),
              h(
                'span',
                { className: 'dsh-goal-progress-heading' },
                h('span', { className: 'dsh-goal-progress-kicker' }, view.kind),
                h('strong', null, view.title),
              ),
              h(
                'span',
                { className: 'dsh-goal-progress-state' },
                observed.status === 'unavailable' ? 'Update unavailable' : view.label,
              ),
              view.counts
                ? h(
                    'span',
                    { className: 'dsh-goal-progress-count' },
                    `${view.counts.done} / ${view.counts.total}`,
                  )
                : null,
            ),
            h(
              'div',
              { className: 'dsh-goal-progress-body' },
              h(
                'p',
                { className: 'dsh-goal-progress-hint' },
                observed.status === 'unavailable'
                  ? 'Showing the last known report. Reopen the chat to retry.'
                  : view.hint,
              ),
              view.counts
                ? h('progress', {
                    value: view.counts.done,
                    max: view.counts.total,
                    'aria-label': 'Completed tasks',
                  })
                : null,
              ['planning', 'proposed'].includes(goal?.phase ?? '')
                ? h(
                    Button,
                    {
                      size: 'sm',
                      variant: 'outline',
                      onClick: () => openConversationPanel(ctx, props.sessionId, 'plan-goals'),
                    },
                    goal?.phase === 'proposed' ? 'Review proposal' : 'Open goal planning',
                  )
                : null,
              h('p', null, 'This report and task state are supplied to the main model.'),
              !['planning', 'proposed'].includes(goal?.phase ?? '') && goal?.progress
                ? h(
                    'div',
                    null,
                    h('p', null, goal!.progress!.summary),
                    h('p', null, `Next: ${goal!.progress!.nextAction}`),
                  )
                : !['planning', 'proposed'].includes(goal?.phase ?? '')
                  ? h('p', null, 'The model has not reported progress yet.')
                  : null,
              goal?.notice || plan?.notice
                ? h('p', { role: 'status' }, goal?.notice ?? plan?.notice)
                : null,
              !goal && plan
                ? h(
                    'ol',
                    null,
                    ...plan.steps.map((step, index) =>
                      h(
                        'li',
                        { key: index },
                        h(
                          'strong',
                          null,
                          `${index < plan.index ? 'Done' : index === plan.index ? 'Current' : 'Pending'} · ${step.title}`,
                        ),
                        h('p', null, step.acceptance),
                        step.evidence
                          ? h(
                              'details',
                              null,
                              h('summary', null, 'Evidence'),
                              h('p', null, step.evidence),
                            )
                          : null,
                      ),
                    ),
                  )
                : null,
              h(
                'ol',
                null,
                ...(goal?.tasks ?? []).map((task) =>
                  h(
                    'li',
                    { key: task.id },
                    h('strong', null, `${taskState(task)} · ${task.title}`),
                    h('p', null, task.acceptance),
                    task.reason ? h('p', null, `Why: ${task.reason}`) : null,
                    task.nextAction ? h('p', null, `Next: ${task.nextAction}`) : null,
                    task.evidence
                      ? h(
                          'details',
                          null,
                          h('summary', null, 'Evidence'),
                          h('p', null, task.evidence),
                        )
                      : null,
                    ['deferred', 'discarded'].includes(task.status ?? '') &&
                      !task.dispositionApproved
                      ? h(
                          Button,
                          {
                            size: 'sm',
                            variant: 'outline',
                            disabled: busy || !task.evidence,
                            onClick: () =>
                              void run(`/goal-exception ${goal!.revision} ${task.id} approve`),
                          },
                          'Approve this exception',
                        )
                      : null,
                  ),
                ),
              ),
              goal?.lastAudit
                ? h(
                    'section',
                    { 'aria-label': 'Independent audit result' },
                    h(
                      'strong',
                      null,
                      goal!.lastAudit!.passed ? 'Audit passed' : 'Audit needs work',
                    ),
                    h('p', null, goal!.lastAudit!.summary),
                    ...goal!.lastAudit!.issues.map((issue) =>
                      h(
                        'p',
                        { key: issue.taskId },
                        `${goal!.tasks.find((t) => t.id === issue.taskId)?.title ?? issue.taskId}: ${issue.reason}. Required: ${issue.requiredAction}`,
                      ),
                    ),
                  )
                : null,
            ),
          ),
        )
      : null
    if (inline) return progress
    const form = draft ?? settings
    return h(
      'section',
      { 'aria-label': 'Chat goal settings' },
      progress,
      h(Checkbox, {
        label: 'Show progress above the composer',
        checked: settings.showProgress !== false,
        disabled: busy,
        onChange: (value: boolean) => void save({ showProgress: value }),
      }),
      h(
        Button,
        {
          size: 'sm',
          variant: 'outline',
          disabled: busy,
          onClick: () => {
            setDraft(settings)
            setEditing(!editing)
          },
        },
        editing ? 'Close goal settings' : 'Edit chat goal settings',
      ),
      editing
        ? h(
            'div',
            null,
            h(Checkbox, {
              label: 'Compact after each completed task',
              checked: form.compactAfterTask !== false,
              disabled: busy,
              onChange: (value: boolean) => setDraft({ ...form, compactAfterTask: value }),
            }),
            h(
              'label',
              null,
              'Completion rule',
              h(
                'select',
                {
                  'aria-label': 'Goal completion rule',
                  value: form.completionMode ?? 'strict',
                  onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
                    setDraft({
                      ...form,
                      completionMode: e.target.value as GoalSettings['completionMode'],
                    }),
                },
                h('option', { value: 'strict' }, 'Every task must be completed'),
                h(
                  'option',
                  { value: 'reviewed_exceptions' },
                  'Allow evidenced, human-approved exceptions',
                ),
              ),
            ),
            h(
              'label',
              null,
              'Independent audits',
              h(
                'select',
                {
                  'aria-label': 'Goal audit mode',
                  value: form.auditMode ?? 'off',
                  onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
                    setDraft({ ...form, auditMode: e.target.value as GoalSettings['auditMode'] }),
                },
                h('option', { value: 'off' }, 'Off'),
                h('option', { value: 'task' }, 'After every task and at completion'),
                h('option', { value: 'goal' }, 'At goal completion'),
              ),
            ),
            form.auditMode !== 'off'
              ? h(Route, {
                  label: 'Independent audit model',
                  disabled: busy,
                  value: `${form.auditorProvider ?? ''}/${form.auditorModel ?? ''}`,
                  onChange: (value) => {
                    const i = value.indexOf('/')
                    setDraft({
                      ...form,
                      auditorProvider: value.slice(0, i),
                      auditorModel: value.slice(i + 1),
                    })
                  },
                })
              : null,
            h(
              'label',
              null,
              'Audit reasoning effort (optional)',
              h(Input, {
                className: 'config-input',
                value: form.auditorEffort ?? '',
                maxLength: 64,
                onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                  setDraft({ ...form, auditorEffort: e.target.value }),
              }),
            ),
            h(
              'p',
              null,
              'Audits receive criteria, task evidence and human clarifications only. A failed review reopens affected tasks. Exceptions never remove the goal’s acceptance criteria.',
            ),
            h(
              Button,
              {
                size: 'sm',
                variant: 'primary',
                disabled: busy,
                onClick: () => void save(form).then(() => setEditing(false)),
              },
              'Save chat goal settings',
            ),
          )
        : null,
      error ? h('p', { role: 'alert' }, error) : null,
    )
  }
}

export const goalProgressTheme = `
.dsh-goal-progress-shell{box-sizing:border-box;width:100%;padding:0 var(--dsh-composer-side-clearance,16px);margin:0 0 8px;min-width:0;}
.dsh-goal-progress{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,760px);margin:0 auto;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-l1);font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow:hidden;}
.dsh-goal-progress-panel .dsh-goal-progress{max-width:none;}
.dsh-goal-progress-summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:12px;padding:12px 16px;min-width:0;}
.dsh-goal-progress-summary::-webkit-details-marker{display:none}.dsh-goal-progress-chevron{font-size:18px;flex:none;transition:transform 120ms;}.dsh-goal-progress[open] .dsh-goal-progress-chevron{transform:rotate(90deg);}
.dsh-goal-progress-heading{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;}.dsh-goal-progress-heading strong{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}.dsh-goal-progress-kicker{font-size:10px;color:var(--dsw-alias-label-tertiary);}.dsh-goal-progress-state{flex:none;padding:3px 8px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}.dsh-goal-progress-count{font-variant-numeric:tabular-nums;flex:none;color:var(--dsw-alias-label-secondary);}
.dsh-goal-progress-body{padding:0 16px 14px;max-height:360px;overflow:auto;border-top:0.5px solid var(--dsw-alias-border-l2);overflow-wrap:anywhere;}.dsh-goal-progress p{margin:8px 0;}.dsh-goal-progress li{padding:6px 0;}.dsh-goal-progress ol{margin:10px 0;padding-left:20px;}.dsh-goal-progress progress{width:100%;height:4px;accent-color:var(--dsw-alias-brand-primary);margin:8px 0;}.dsh-goal-progress-hint{color:var(--dsw-alias-label-secondary);}
@media(max-width:480px){.dsh-goal-progress-summary{padding:10px 12px;gap:8px;flex-wrap:wrap}.dsh-goal-progress-heading{flex-basis:calc(100% - 32px)}.dsh-goal-progress-state{margin-left:26px}.dsh-goal-progress-body{padding:0 12px 12px}}
`
