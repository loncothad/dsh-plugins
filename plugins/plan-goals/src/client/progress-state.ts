import type { ManagedGoal } from '../goal-book.ts'
import type { SisyphusPlan } from '../types.ts'

interface NativeGoal {
  id: string
  phase: string
}
/** Presentation state reflects actual planning/execution rather than an empty task denominator. */
export function progressPresentation(
  goal?: ManagedGoal,
  plan?: SisyphusPlan | null,
  native?: NativeGoal,
) {
  if (goal?.phase === 'archived') return undefined
  const ordered = plan && native?.id === plan.goalId ? plan : undefined
  if (!goal && !ordered) return undefined
  const phase = goal?.phase ?? ordered!.phase
  const current =
    ordered && (!goal?.nativeId || goal.nativeId === ordered.goalId) ? ordered : undefined
  const labels: Record<string, [string, string]> = {
    planning: ['Planning', 'Clarify the scope in chat. Work starts after you review the proposal.'],
    proposed: [
      'Awaiting review',
      'Review the objective, tasks and completion checks before starting.',
    ],
    active: ['In progress', 'Current progress and task state are shared with the model.'],
    paused: ['Paused', 'The goal is retained. Resume when you are ready to continue.'],
    blocked: ['Blocked', 'Review the blocking reason and the next action below.'],
    complete: ['Completed', 'Accepted task evidence and audit results remain available below.'],
    review: ['Checkpoint review', 'Review this step’s evidence before the next step begins.'],
  }
  const visiblePhase =
    current?.phase === 'review' && !['planning', 'proposed', 'complete'].includes(phase)
      ? 'review'
      : phase === 'active' &&
          native &&
          native.id === goal?.nativeId &&
          ['paused', 'complete'].includes(native.phase)
        ? native.phase
        : phase
  const [label, hint] = labels[visiblePhase] ?? [
    'Awaiting update',
    'The goal has not reported its current execution state.',
  ]
  const total = goal?.tasks.length ?? current?.steps.length ?? 0,
    done = goal ? goal.tasks.filter((t) => t.done).length : (current?.index ?? 0)
  return {
    title: goal?.objective ?? current!.title,
    kind: goal?.kind === 'sisyphus' || (!goal && current) ? 'Ordered goal' : 'Goal',
    label,
    hint,
    counts:
      !['planning', 'proposed'].includes(visiblePhase) && total > 0 ? { done, total } : undefined,
  }
}
