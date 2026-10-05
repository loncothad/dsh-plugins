import { expect, it } from 'vitest'
import { progressPresentation } from '../src/client/progress-state.ts'
import type { ManagedGoal } from '../src/goal-book.ts'
import type { SisyphusPlan } from '../src/types.ts'

const goal = (phase: ManagedGoal['phase'], tasks: ManagedGoal['tasks'] = []): ManagedGoal => ({
  id: 'g',
  revision: 1,
  kind: 'regular',
  objective: 'Implement CSV export',
  criteria: ['Tests pass'],
  tasks,
  audit: false,
  phase,
  nativeId: 'native',
})
const task = { id: 't', title: 'Export', acceptance: 'Fixture passes', done: false }
it('does not display a cleared goal, an archived goal, or a stale ordered plan', () => {
  expect(progressPresentation()).toBeUndefined()
  expect(progressPresentation(goal('archived'))).toBeUndefined()
  const plan = {
    goalId: 'old',
    phase: 'active',
    title: 'Stale plan',
    steps: [],
  } as unknown as SisyphusPlan
  expect(progressPresentation(undefined, plan, { id: 'new', phase: 'active' })).toBeUndefined()
})
it.each([
  ['planning', 'Planning'],
  ['proposed', 'Awaiting review'],
])('renders %s without an empty denominator or progress meter', (phase, label) => {
  const v = progressPresentation(goal(phase as ManagedGoal['phase'], [task]))!
  expect(v.label).toBe(label)
  expect(v.counts).toBeUndefined()
  expect(v.hint).toMatch(/review|scope/i)
})
it.each([
  ['active', 'In progress'],
  ['paused', 'Paused'],
  ['blocked', 'Blocked'],
  ['complete', 'Completed'],
])('renders %s with retained progress', (phase, label) => {
  const v = progressPresentation(
    goal(phase as ManagedGoal['phase'], [
      task,
      { ...task, id: 'done', done: true, evidence: 'Pass' },
    ]),
  )!
  expect(v.label).toBe(label)
  expect(v.counts).toEqual({ done: 1, total: 2 })
  expect(v.title).toBe('Implement CSV export')
  expect(progressPresentation(goal(phase as ManagedGoal['phase']))!.counts).toBeUndefined()
})
it('follows the matching native pause/completion and ordered checkpoint review only', () => {
  expect(
    progressPresentation(goal('active'), undefined, { id: 'native', phase: 'paused' })!.label,
  ).toBe('Paused')
  expect(
    progressPresentation(goal('active'), undefined, { id: 'another', phase: 'complete' })!.label,
  ).toBe('In progress')
  const plan = {
    goalId: 'native',
    phase: 'review',
    title: 'Ordered steps',
    steps: [{ title: 'One', acceptance: 'Pass' }],
    index: 0,
  } as SisyphusPlan
  expect(progressPresentation(undefined, plan, { id: 'native', phase: 'active' })).toMatchObject({
    label: 'Checkpoint review',
    kind: 'Ordered goal',
    counts: { done: 0, total: 1 },
  })
})

it('does not let a native pause or stale checkpoint overwrite a planning, review or blocked state', () => {
  const plan = {
    goalId: 'native',
    phase: 'review',
    id: 'plan',
    revision: 1,
    failures: 0,
    title: 'Previous goal',
    steps: [],
    index: 0,
  } as SisyphusPlan
  expect(
    progressPresentation(goal('planning'), plan, { id: 'native', phase: 'complete' })!.label,
  ).toBe('Planning')
  expect(
    progressPresentation(goal('proposed'), plan, { id: 'native', phase: 'complete' })!.label,
  ).toBe('Awaiting review')
  expect(
    progressPresentation(goal('blocked'), undefined, { id: 'native', phase: 'paused' })!.label,
  ).toBe('Blocked')
})
