import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { ManagedGoal } from '../src/goal-book.ts'
import { proposalSchema, proposalTasks } from '../src/proposal.ts'

const limits = { maxSteps: 10, maxSubtaskDepth: 4 }
const baseline = (): ManagedGoal => ({
  id: randomUUID(),
  revision: 1,
  kind: 'regular',
  phase: 'paused',
  objective: 'CSV',
  criteria: ['Works'],
  audit: false,
  tasks: [
    {
      id: randomUUID(),
      title: 'Implement',
      acceptance: 'Fixture passes',
      done: true,
      evidence: 'Receipt',
    },
    {
      id: randomUUID(),
      title: 'Check encoding',
      acceptance: 'UTF-8 pass',
      done: false,
      status: 'blocked',
      reason: 'Needs data',
      nextAction: 'Provide fixture',
      evidence: 'Earlier check',
    },
  ],
})
it('retains accepted evidence and unchanged unfinished identity, resetting obsolete attestations only for revised work', () => {
  const g = baseline(),
    pending = g.tasks[1]!,
    proposal = proposalSchema.parse({
      objective: 'CSV',
      criteria: ['Works'],
      tasks: [{ id: pending.id, title: pending.title, acceptance: pending.acceptance }],
    })
  expect(proposalTasks(proposal, 'regular', limits, g)).toEqual(g.tasks)
  proposal.tasks[0]!.acceptance = 'UTF-16 pass'
  const next = proposalTasks(proposal, 'regular', limits, g)
  expect(next[0]).toEqual(g.tasks[0])
  expect(next[1]).toMatchObject({
    id: pending.id,
    done: false,
    status: 'pending',
    auditState: 'pending',
    acceptance: 'UTF-16 pass',
  })
  expect(next[1]?.evidence).toBeUndefined()
  expect(g.tasks[1]?.evidence).toBe('Earlier check')
})
it('replacement tasks are fresh and cannot import prior task IDs or accepted completion', () => {
  const g = baseline(),
    p = proposalSchema.parse({
      objective: 'Different outcome',
      criteria: ['Different check'],
      tasks: [{ title: 'Fresh work', acceptance: 'New receipt' }],
    })
  const tasks = proposalTasks(p, 'regular', limits)
  expect(tasks).toHaveLength(1)
  expect(tasks[0]?.done).toBe(false)
  expect(g.tasks.map((t) => t.id)).not.toContain(tasks[0]?.id)
  p.tasks[0]!.id = g.tasks[0]!.id
  expect(() => proposalTasks(p, 'regular', limits)).toThrow('unfinished task IDs')
})
it('keeps explicit dependencies and rejects dropping a parent referenced by retained evidence', () => {
  const g = baseline(),
    parent = g.tasks[1]!,
    child = {
      id: randomUUID(),
      title: 'Subcheck',
      acceptance: 'Nested proof',
      done: true,
      evidence: 'Receipt',
      parentId: parent.id,
    }
  g.tasks.push(child)
  const p = proposalSchema.parse({
    objective: 'CSV',
    criteria: ['Works'],
    tasks: [{ id: parent.id, title: parent.title, acceptance: parent.acceptance }],
  })
  expect(proposalTasks(p, 'regular', limits, g).find((t) => t.id === child.id)?.parentId).toBe(
    parent.id,
  )
  p.tasks = [{ title: 'Unrelated', acceptance: 'Proof' }]
  expect(() => proposalTasks(p, 'regular', limits, g)).toThrow('parent')
})
it('bounds the task graph and rejects duplicated IDs and invalid parent ordering', () => {
  const g = baseline(),
    t = g.tasks[1]!,
    p = proposalSchema.parse({
      objective: 'CSV',
      criteria: ['Works'],
      tasks: [{ id: t.id, title: t.title, acceptance: t.acceptance }],
    })
  p.tasks.push({ ...p.tasks[0]! })
  expect(() => proposalTasks(p, 'regular', limits, g)).toThrow('distinct')
  p.tasks.pop()
  p.tasks[0]!.parentIndex = 0
  expect(() => proposalTasks(p, 'regular', limits, g)).toThrow('precede')
  delete p.tasks[0]!.parentIndex
  expect(() => proposalTasks(p, 'regular', { ...limits, maxSteps: 1 }, g)).toThrow('Too many')
})

it('validates inherited dependency cycles, depth and explicit detachment', () => {
  const g = baseline()
  g.tasks[0]!.done = false
  g.tasks[0]!.parentId = g.tasks[1]!.id
  const p = proposalSchema.parse({
    objective: 'CSV',
    criteria: ['Works'],
    tasks: g.tasks.map((t) => ({ id: t.id, title: t.title, acceptance: t.acceptance })),
  })
  expect(() => proposalTasks(p, 'regular', { ...limits, maxSubtaskDepth: 0 }, g)).toThrow('depth')
  p.tasks[1]!.parentIndex = 0
  expect(() => proposalTasks(p, 'regular', limits, g)).toThrow('cycle')
  p.tasks[0]!.parentIndex = null
  expect(proposalTasks(p, 'regular', limits, g)[0]?.parentId).toBeUndefined()
})
