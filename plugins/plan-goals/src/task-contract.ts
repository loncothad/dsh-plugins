import type { ManagedGoal } from './goal-book.ts'
export const taskState = (task: ManagedGoal['tasks'][number]) =>
  task.done ? 'completed' : (task.status ?? 'pending')
export function completionProblems(
  goal: ManagedGoal,
  mode: 'strict' | 'reviewed_exceptions',
): string[] {
  return goal.tasks.flatMap((task) => {
    if (task.done && task.evidence?.trim() && task.auditState !== 'rejected') return []
    if (
      mode === 'reviewed_exceptions' &&
      ['deferred', 'discarded'].includes(task.status ?? '') &&
      task.dispositionApproved &&
      task.reason?.trim() &&
      task.evidence?.trim()
    )
      return []
    return [`${task.title}: ${taskState(task)}${task.reason ? ` (${task.reason})` : ''}`]
  })
}
/** Rejecting a child reopens all completed ancestors; evidence remains inspectable. */
export function invalidateTasks(goal: ManagedGoal, ids: readonly string[]): ManagedGoal {
  const invalid = new Set(ids)
  for (const id of ids) {
    let parent = goal.tasks.find((task) => task.id === id)?.parentId
    while (parent) {
      invalid.add(parent)
      parent = goal.tasks.find((task) => task.id === parent)?.parentId
    }
  }
  return {
    ...goal,
    tasks: goal.tasks.map((task) =>
      invalid.has(task.id)
        ? {
            ...task,
            done: false,
            status: 'pending',
            auditState: 'rejected',
            dispositionApproved: false,
          }
        : task,
    ),
  }
}
export function progressReport(goal: ManagedGoal): string {
  const completed = goal.tasks.filter((task) => task.done).length,
    blocked = goal.tasks.filter((task) => task.status === 'blocked').length
  const header = `${goal.objective}\nCompletion criteria: ${goal.criteria.join('; ')}\nProgress: ${completed}/${goal.tasks.length} completed; ${blocked} blocked. Phase: ${goal.phase}.\n${goal.progress ? `Report: ${goal.progress.summary}\nNext: ${goal.progress.nextAction}\n` : ''}`
  const budget = 32768
  let report = header
  let omitted = 0
  const ordered = [
    ...goal.tasks.filter((task) => !task.done),
    ...goal.tasks.filter((task) => task.done),
  ]
  for (const task of ordered) {
    const line = `- [${taskState(task)}] ${task.id}: ${task.title}; acceptance: ${task.acceptance}${task.reason ? `; reason: ${task.reason}` : ''}${task.nextAction ? `; next: ${task.nextAction}` : ''}${task.evidence ? `; evidence: ${task.evidence.slice(0, 512)}${task.evidence.length > 512 ? ' (full receipt in get_goals)' : ''}` : ''}\n`
    if (report.length + line.length > budget) {
      omitted++
      continue
    }
    report += line
  }
  return (
    report +
    (omitted
      ? `\n${omitted} task details omitted from this bounded report. Read get_goals for complete evidence.`
      : '')
  )
}
