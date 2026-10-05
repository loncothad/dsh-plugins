import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { reviewGoal } from '../src/audit.ts'
import { resolvePolicy } from '../src/config.ts'
import type { ManagedGoal } from '../src/goal-book.ts'
import { completionProblems, invalidateTasks, progressReport } from '../src/task-contract.ts'

const parent = randomUUID(),
  child = randomUUID()
const goal: ManagedGoal = {
  id: randomUUID(),
  revision: 1,
  kind: 'regular',
  objective: 'Export CSV',
  criteria: ['UTF-8 output'],
  audit: true,
  phase: 'active',
  tasks: [
    {
      id: parent,
      title: 'Export',
      acceptance: 'Checks pass',
      done: true,
      evidence: 'test receipt',
    },
    {
      id: child,
      parentId: parent,
      title: 'Encoding',
      acceptance: 'UTF-8 verified',
      done: true,
      evidence: 'fixture',
    },
  ],
}
it('reopens failed tasks and their ancestors, while preserving prior evidence', () => {
  const next = invalidateTasks(goal, [child])
  expect(next.tasks.every((t) => !t.done && t.auditState === 'rejected')).toBe(true)
  expect(next.tasks[0]?.evidence).toBe('test receipt')
  expect(goal.tasks.every((t) => t.done)).toBe(true)
})
it('requires evidence and explicit human review for exceptions, and compacts accepted tasks by default', () => {
  expect(resolvePolicy({}).compactAfterTask).toBe(true)
  const deferred = {
    ...goal,
    tasks: [
      {
        ...goal.tasks[0]!,
        done: false,
        status: 'deferred' as const,
        reason: 'Platform unavailable',
        nextAction: 'Run on Windows',
        dispositionApproved: false,
      },
    ],
  }
  expect(completionProblems(deferred, 'reviewed_exceptions')).toHaveLength(1)
  deferred.tasks[0]!.dispositionApproved = true
  expect(completionProblems(deferred, 'reviewed_exceptions')).toHaveLength(0)
  expect(completionProblems(deferred, 'strict')).toHaveLength(1)
  expect(progressReport(deferred)).toContain('Platform unavailable')
})
it('sends a self-contained audit packet without chat context and rejects fabricated task identities', async () => {
  let packet = ''
  let system = ''
  const ctx = {
    llm: {
      prepareCall: async () => ({
        config: {},
        async *stream(request: { system: string; messages: { content: { text: string }[] }[] }) {
          system = request.system
          packet = request.messages[0]!.content[0]!.text
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'text',
              text: JSON.stringify({
                passed: false,
                summary: 'Encoding lacks independent evidence',
                issues: [{ taskId: child, reason: 'Only a claim', requiredAction: 'Run verifier' }],
              }),
            },
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
  } as unknown as Context
  const verdict = await reviewGoal(
    ctx,
    resolvePolicy({ auditorProvider: 'fixture', auditorModel: 'auditor' }),
    { revision: 1, goals: [goal] },
    goal,
    new AbortController().signal,
  )
  expect(verdict.issues[0]?.taskId).toBe(child)
  expect(system).toContain('no conversation history')
  expect(JSON.parse(packet)).not.toHaveProperty('messages')
  expect(JSON.parse(packet)).not.toHaveProperty('evidence')
  expect(JSON.parse(packet).criteria).toEqual(goal.criteria)
})
