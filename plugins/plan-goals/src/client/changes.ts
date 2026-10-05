import type { ManagedGoal } from '../goal-book.ts'
export function goalChanges(before: ManagedGoal, after: ManagedGoal) {
  const ids = new Set(after.tasks.map((t) => t.id)),
    oldIds = new Set(before.tasks.map((t) => t.id))
  return {
    objectiveChanged: before.objective !== after.objective,
    addedChecks: after.criteria.filter((c) => !before.criteria.includes(c)),
    removedChecks: before.criteria.filter((c) => !after.criteria.includes(c)),
    completedRetained: after.tasks.filter((t) => t.done && oldIds.has(t.id)).length,
    addedTasks: after.tasks.filter((t) => !oldIds.has(t.id)),
    removedTasks: before.tasks.filter((t) => !t.done && !ids.has(t.id)),
    changedTasks: after.tasks.filter((t) => {
      const old = before.tasks.find((o) => o.id === t.id)
      return (
        old &&
        (old.title !== t.title || old.acceptance !== t.acceptance || old.parentId !== t.parentId)
      )
    }),
  }
}
