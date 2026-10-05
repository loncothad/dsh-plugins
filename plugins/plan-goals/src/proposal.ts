/** Amendments reuse unfinished task identity and immutable accepted evidence. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ManagedGoal } from './goal-book.ts'
export const proposalSchema = z
  .object({
    objective: z.string().min(1).max(4096),
    criteria: z.array(z.string().min(1).max(2048)).min(1).max(32),
    tasks: z
      .array(
        z
          .object({
            id: z.string().uuid().optional(),
            title: z.string().min(1).max(1024),
            acceptance: z.string().min(1).max(2048),
            parentIndex: z.number().int().nonnegative().nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    audit: z.boolean().optional(),
  })
  .strict()
export type Proposal = z.infer<typeof proposalSchema>
export function proposalTasks(
  proposal: Proposal,
  kind: ManagedGoal['kind'],
  limits: { maxSteps: number; maxSubtaskDepth: number },
  baseline?: ManagedGoal,
): ManagedGoal['tasks'] {
  const retained = baseline?.tasks.filter((t) => t.done) ?? [],
    previous = new Map(baseline?.tasks.map((t) => [t.id, t]) ?? []),
    ids = proposal.tasks.map((t) => t.id ?? randomUUID())
  if (new Set(ids).size !== ids.length) throw Error('Task identities must be distinct')
  if (retained.length + ids.length > limits.maxSteps) throw Error('Too many tasks')
  const tasks = proposal.tasks.map((t, index) => {
    if (t.id && (!previous.has(t.id) || previous.get(t.id)!.done))
      throw Error(
        'Use existing unfinished task IDs only. Completed tasks are retained automatically.',
      )
    if (
      t.parentIndex !== undefined &&
      t.parentIndex !== null &&
      (kind === 'sisyphus' || t.parentIndex >= index)
    )
      throw Error('Parent subtasks must precede their children; ordered steps remain flat')
    let depth = 0,
      parent = t.parentIndex
    while (parent !== undefined && parent !== null) {
      if (++depth > limits.maxSubtaskDepth) throw Error('Subtask depth exceeds policy')
      parent = proposal.tasks[parent]?.parentIndex
    }
    const prior = t.id ? previous.get(t.id) : undefined,
      parentId =
        t.parentIndex === undefined
          ? prior?.parentId
          : t.parentIndex === null
            ? undefined
            : ids[t.parentIndex]
    if (
      prior &&
      prior.title === t.title &&
      prior.acceptance === t.acceptance &&
      prior.parentId === parentId
    )
      return { ...prior }
    return {
      id: ids[index]!,
      title: t.title,
      acceptance: t.acceptance,
      done: false,
      ...(parentId ? { parentId } : {}),
      ...(prior ? { status: 'pending' as const, auditState: 'pending' as const } : {}),
    }
  })
  const all = [...retained, ...tasks],
    allIds = new Set(all.map((t) => t.id))
  if (all.some((t) => t.parentId && !allIds.has(t.parentId)))
    throw Error(
      'A retained completed subtask still depends on its parent. Include that unfinished parent with its existing ID.',
    )
  const byId = new Map(all.map((t) => [t.id, t]))
  for (const task of all) {
    const seen = new Set([task.id])
    let parent = task.parentId,
      depth = 0
    while (parent) {
      if (seen.has(parent)) throw Error('Task dependencies contain a cycle')
      if (++depth > limits.maxSubtaskDepth) throw Error('Subtask depth exceeds policy')
      seen.add(parent)
      parent = byId.get(parent)?.parentId
    }
  }
  return all
}
