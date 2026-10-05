import type { Context } from '@deepseek-ai/cordis'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { privateStateClient } from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h, useEffect, useRef, useState } from 'react'
import { goalBookSchema } from '../goal-book.ts'
import { taskState } from '../task-contract.ts'
import { goalChanges } from './changes.ts'
export function goalReview(
  ctx: Context,
): React.ComponentType<PropsRuntime<'conversation.input.left'>> {
  const useBook = privateStateClient(ctx, 'goalBook', (value) => goalBookSchema.parse(value))
  return function Review(props: PropsRuntime<'conversation.input.left'>) {
    const book = useBook(props.sessionId),
      draft = book?.goals.find((row) => row.id === book.draft),
      focused = book?.goals.find((row) => row.id === book.focused),
      [selected, setSelected] = useState(''),
      [change, setChange] = useState(''),
      [mode, setMode] = useState<'tweak' | 'replace'>('tweak'),
      [kind, setKind] = useState<'regular' | 'sisyphus'>('regular'),
      [busy, setBusy] = useState(false),
      [error, setError] = useState(''),
      pending = useRef<string>(),
      contextKey = `${props.sessionId}:${focused?.id ?? ''}`,
      session = useRef(contextKey),
      operation = book?.draftOperation,
      before =
        operation?.kind === 'tweak'
          ? book?.draftBaseline
          : book?.goals.find((g) => g.id === operation?.sourceId),
      changes = before && draft?.phase === 'proposed' ? goalChanges(before, draft) : undefined,
      saved = book?.goals.find((g) => g.id === selected)
    session.current = contextKey
    useEffect(() => {
      session.current = contextKey
      pending.current = undefined
      setChange('')
      setSelected('')
      setError('')
      setBusy(false)
      setMode('tweak')
      setKind(focused?.kind ?? 'regular')
    }, [contextKey, focused?.kind])
    const run = async (command: string) => {
      const id = props.sessionId,
        token = contextKey
      if (pending.current === token) return
      pending.current = token
      setBusy(true)
      setError('')
      try {
        const response = await ctx.remote.commands.execute(id, command, [])
        if (!response.ok) throw new Error(response.error.message)
        if (!response.value) throw Error('Goal command is unavailable')
        if (response.value?.result.kind === 'error') throw new Error(response.value.result.text)
        if (session.current === token) setChange('')
      } catch (error) {
        if (session.current === token)
          setError(error instanceof Error ? error.message : 'Goal operation failed')
      } finally {
        if (pending.current === token) pending.current = undefined
        if (session.current === token) setBusy(false)
      }
    }
    return h(
      'section',
      { 'aria-label': 'Reviewed goals' },
      h(
        'style',
        null,
        '.goal-change-editor{border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:12px 14px;margin:16px 0}.goal-change-editor legend{padding:0 6px;color:var(--dsw-alias-label-secondary);font-size:12px}.goal-change-editor p{margin:8px 0;line-height:1.5}',
      ),
      draft
        ? h(
            'div',
            { className: 'config-editor-row' },
            h(
              'h3',
              null,
              draft.phase === 'planning'
                ? operation?.kind === 'tweak'
                  ? 'Planning amendment'
                  : operation?.kind === 'replace'
                    ? 'Planning replacement'
                    : 'Planning goal'
                : operation?.kind === 'tweak'
                  ? 'Review goal amendment'
                  : operation?.kind === 'replace'
                    ? 'Review replacement goal'
                    : 'Review goal proposal',
            ),
            h('p', null, draft.objective),
            operation
              ? h(
                  'p',
                  null,
                  operation.kind === 'tweak'
                    ? 'Same goal. Completed task evidence is retained; unfinished work can change.'
                    : 'Fresh goal and task list. The source goal stays paused and is archived only after confirmation.',
                )
              : null,
            draft.notice ? h('p', null, draft.notice) : null,
            changes
              ? h(
                  'section',
                  { 'aria-label': 'Proposed goal changes' },
                  h('h4', null, 'Changes to review'),
                  changes.objectiveChanged
                    ? h('p', null, `Previous objective: ${before!.objective}`)
                    : null,
                  ...changes.removedChecks.map((c) =>
                    h('p', { key: `remove:${c}` }, `Remove completion check: ${c}`),
                  ),
                  ...changes.addedChecks.map((c) =>
                    h('p', { key: `add:${c}` }, `Add completion check: ${c}`),
                  ),
                  h(
                    'p',
                    null,
                    `${changes.completedRetained} completed tasks retained; ${changes.addedTasks.length} added; ${changes.changedTasks.length} revised; ${changes.removedTasks.length} removed.`,
                  ),
                  ...changes.removedTasks.map((t) =>
                    h('p', { key: t.id }, `Remove unfinished task: ${t.title}`),
                  ),
                  ...changes.changedTasks.map((t) =>
                    h('p', { key: t.id }, `Revise task: ${t.title}`),
                  ),
                  h('p', null, 'Completion audits are refreshed for the accepted scope.'),
                )
              : null,
            draft.phase === 'planning'
              ? h(
                  'p',
                  null,
                  'Discuss the goal in chat. The model will submit a proposal here. Execution waits for your approval.',
                )
              : h(
                  'div',
                  null,
                  h('h4', null, 'Completion checks'),
                  h(
                    'ul',
                    null,
                    ...draft.criteria.map((text, index) => h('li', { key: index }, text)),
                  ),
                  h('h4', null, 'Tasks'),
                  h(
                    'ol',
                    null,
                    ...draft.tasks.map((task) =>
                      h(
                        'li',
                        { key: task.id },
                        h('strong', null, `${taskState(task)} · ${task.title}`),
                        h('p', null, task.acceptance),
                        task.evidence
                          ? h(
                              'details',
                              null,
                              h('summary', null, 'Retained evidence'),
                              h('p', null, task.evidence),
                            )
                          : null,
                      ),
                    ),
                  ),
                  h(
                    Button,
                    {
                      type: 'button',
                      size: 'sm',
                      variant: 'primary',
                      disabled: busy,
                      onClick: () => {
                        void run(`/goal-start ${draft.id} ${draft.revision}`)
                      },
                    },
                    operation?.kind === 'tweak'
                      ? 'Confirm amendment and resume'
                      : operation?.kind === 'replace'
                        ? 'Confirm replacement and start'
                        : 'Confirm and start goal',
                  ),
                ),
            h(
              Button,
              {
                type: 'button',
                size: 'sm',
                variant: 'ghost',
                disabled: busy,
                onClick: () => {
                  void run('/goal-cancel')
                },
              },
              'Cancel draft',
            ),
          )
        : null,
      focused && focused.id !== draft?.id
        ? h(
            'div',
            { className: 'config-editor-row' },
            h('h3', null, focused.objective),
            h(
              'p',
              null,
              `${focused.kind} goal · ${focused.phase} · ${focused.tasks.filter((task) => task.done).length}/${focused.tasks.length} tasks with evidence`,
            ),
            focused.notice ? h('p', { role: 'status' }, focused.notice) : null,
            h(
              'div',
              { className: 'config-actions' },
              h(
                Button,
                {
                  type: 'button',
                  size: 'sm',
                  variant: 'outline',
                  disabled: busy || Boolean(draft) || focused.phase !== 'active',
                  onClick: () => {
                    void run('/goal-pause')
                  },
                },
                'Pause goal',
              ),
              h(
                Button,
                {
                  type: 'button',
                  size: 'sm',
                  variant: 'outline',
                  disabled:
                    busy || Boolean(draft) || !['paused', 'blocked'].includes(focused.phase),
                  onClick: () => {
                    void run('/goal-resume')
                  },
                },
                'Resume goal',
              ),
              h(
                Button,
                {
                  type: 'button',
                  size: 'sm',
                  variant: 'ghost',
                  disabled: busy,
                  onClick: () => {
                    void run('/goal-unfocus')
                  },
                },
                'Leave open',
              ),
            ),
            !draft && ['active', 'paused', 'blocked'].includes(focused.phase)
              ? h(
                  'fieldset',
                  { className: 'goal-change-editor' },
                  h('legend', null, 'Change this goal'),
                  h(
                    'label',
                    null,
                    'Goal change action',
                    h(
                      'select',
                      {
                        'aria-label': 'Goal change action',
                        value: mode,
                        disabled: busy,
                        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
                          setMode(e.target.value as 'tweak' | 'replace')
                          setKind(focused.kind)
                        },
                      },
                      h('option', { value: 'tweak' }, 'Amend current goal'),
                      h('option', { value: 'replace' }, 'Replace with a new goal'),
                    ),
                  ),
                  h(
                    'p',
                    null,
                    mode === 'tweak'
                      ? 'Keep this goal and its completed evidence. Review changes to unfinished work.'
                      : 'Start a fresh plan. Archive this goal only after the replacement is confirmed.',
                  ),
                  mode === 'replace'
                    ? h(
                        'label',
                        null,
                        'Replacement goal type',
                        h(
                          'select',
                          {
                            'aria-label': 'Replacement goal type',
                            value: kind,
                            disabled: busy,
                            onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
                              setKind(e.target.value as 'regular' | 'sisyphus'),
                          },
                          h('option', { value: 'regular' }, 'Regular'),
                          h('option', { value: 'sisyphus' }, 'Ordered'),
                        ),
                      )
                    : null,
                  h(
                    'label',
                    null,
                    mode === 'tweak' ? 'Change to current goal' : 'New goal',
                    h(Input, {
                      className: 'config-input',
                      value: change,
                      disabled: busy,
                      maxLength: 4096,
                      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                        setChange(e.target.value),
                    }),
                  ),
                  h(
                    Button,
                    {
                      type: 'button',
                      size: 'sm',
                      variant: 'outline',
                      disabled: busy || !change.trim(),
                      onClick: () =>
                        void run(
                          mode === 'tweak'
                            ? `/goal-tweak ${change}`
                            : `/goal-replace ${kind} :: ${change}`,
                        ),
                    },
                    mode === 'tweak' ? 'Review amendment' : 'Review replacement',
                  ),
                )
              : null,
          )
        : null,
      book?.goals.length
        ? h(
            'details',
            null,
            h('summary', null, `Saved goals (${book.goals.length})`),
            h(
              'label',
              null,
              'Open goal',
              h(
                'select',
                {
                  'aria-label': 'Open goal',
                  value: selected,
                  onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
                    setSelected(event.target.value),
                },
                h('option', { value: '' }, 'Choose a goal'),
                ...book.goals.map((row) =>
                  h(
                    'option',
                    { key: row.id, value: row.id },
                    `${row.objective.slice(0, 80)} (${row.phase})`,
                  ),
                ),
              ),
            ),
            h(
              Button,
              {
                type: 'button',
                size: 'sm',
                variant: 'outline',
                disabled:
                  busy ||
                  Boolean(draft) ||
                  !book.goals.some(
                    (row) => row.id === selected && ['paused', 'blocked'].includes(row.phase),
                  ),
                onClick: () => {
                  void run(`/goal-focus ${selected}`)
                },
              },
              'Focus goal',
            ),
            saved
              ? h(
                  'section',
                  { 'aria-label': 'Saved goal details' },
                  h('h4', null, saved.objective),
                  h('p', null, `${saved.kind} · ${saved.phase}`),
                  saved.replacedBy
                    ? h(
                        'p',
                        null,
                        `Replaced by: ${book.goals.find((g) => g.id === saved.replacedBy)?.objective ?? 'archived replacement'}`,
                      )
                    : null,
                  h('ul', null, ...saved.criteria.map((c, i) => h('li', { key: i }, c))),
                  h(
                    'ol',
                    null,
                    ...saved.tasks.map((t) =>
                      h(
                        'li',
                        { key: t.id },
                        h('strong', null, `${taskState(t)} · ${t.title}`),
                        h('p', null, t.acceptance),
                        t.reason ? h('p', null, t.reason) : null,
                        t.evidence
                          ? h(
                              'details',
                              null,
                              h('summary', null, 'Evidence'),
                              h('p', null, t.evidence),
                            )
                          : null,
                      ),
                    ),
                  ),
                )
              : null,
          )
        : null,
      error ? h('p', { role: 'alert' }, error) : null,
    )
  }
}
