import { z } from 'zod'
export const goalSettingsSchema = z
  .object({
    completionMode: z.enum(['strict', 'reviewed_exceptions']).optional(),
    auditMode: z.enum(['off', 'task', 'goal']).optional(),
    auditorProvider: z.string().max(256).optional(),
    auditorModel: z.string().max(512).optional(),
    auditorEffort: z.string().max(64).optional(),
    showProgress: z.boolean().optional(),
    compactAfterTask: z.boolean().optional(),
  })
  .strict()
export const taskSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(1024),
    acceptance: z.string().min(1).max(2048),
    done: z.boolean(),
    evidence: z.string().max(8192).optional(),
    parentId: z.string().uuid().optional(),
    status: z.enum(['pending', 'active', 'blocked', 'deferred', 'discarded']).optional(),
    reason: z.string().max(2048).optional(),
    nextAction: z.string().max(2048).optional(),
    dispositionApproved: z.boolean().optional(),
    auditState: z.enum(['pending', 'passed', 'rejected']).optional(),
  })
  .strict()
const entrySchema = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    kind: z.enum(['regular', 'sisyphus']),
    objective: z.string().min(1).max(4096),
    criteria: z.array(z.string().min(1).max(2048)).min(1).max(32),
    tasks: z.array(taskSchema).max(128),
    audit: z.boolean(),
    phase: z.enum(['planning', 'proposed', 'active', 'paused', 'blocked', 'complete', 'archived']),
    nativeId: z.string().optional(),
    replaces: z.string().uuid().optional(),
    replacedBy: z.string().uuid().optional(),
    nativeTaskIds: z.array(z.string().uuid()).max(128).optional(),
    notice: z.string().max(4096).optional(),
    settings: goalSettingsSchema.optional(),
    clarifications: z
      .array(z.object({ question: z.string().max(2048), answer: z.string().max(4096) }).strict())
      .max(16)
      .optional(),
    progress: z
      .object({
        summary: z.string().max(2048),
        nextAction: z.string().max(2048),
        at: z.number().finite(),
      })
      .strict()
      .optional(),
    lastAudit: z
      .object({
        passed: z.boolean(),
        summary: z.string().max(2048),
        issues: z
          .array(
            z
              .object({
                taskId: z.string().uuid(),
                reason: z.string().max(2048),
                requiredAction: z.string().max(2048),
              })
              .strict(),
          )
          .max(128),
        provider: z.string(),
        model: z.string(),
        at: z.number().finite(),
        taskId: z.string().uuid().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
const rawGoalBookSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    focused: z.string().uuid().optional(),
    draft: z.string().uuid().optional(),
    draftBaseline: entrySchema.optional(),
    draftOperation: z
      .object({
        kind: z.enum(['tweak', 'replace']),
        sourceId: z.string().uuid(),
        sourceRevision: z.number().int().positive(),
        request: z.string().min(1).max(4096),
      })
      .strict()
      .optional(),
    goals: z.array(entrySchema).max(128),
    settings: goalSettingsSchema.optional(),
  })
  .strict()
  .superRefine((book, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(book)).length > 1048576)
      ctx.addIssue({
        code: 'custom',
        message: 'Saved goal metadata exceeds one MiB. Prune archived goals.',
      })
    if (new Set(book.goals.map((goal) => goal.id)).size !== book.goals.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate goal identity' })
    if (book.draftOperation) {
      const op = book.draftOperation,
        draft = book.goals.find((g) => g.id === book.draft)
      if (
        !draft ||
        !book.goals.some((g) => g.id === op.sourceId) ||
        (op.kind === 'tweak'
          ? book.draft !== op.sourceId || book.draftBaseline?.id !== op.sourceId
          : book.draft === op.sourceId || draft.replaces !== op.sourceId)
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid goal review relationship' })
    }
    for (const goal of book.goals) {
      const ids = new Set(goal.tasks.map((task) => task.id))
      if (ids.size !== goal.tasks.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate task identity' })
      for (const task of goal.tasks) {
        if (task.done && !task.evidence?.trim())
          ctx.addIssue({ code: 'custom', message: 'Completed tasks require evidence' })
        if (
          ['blocked', 'deferred', 'discarded'].includes(task.status ?? '') &&
          !task.reason?.trim()
        )
          ctx.addIssue({
            code: 'custom',
            message: 'Blocked or deferred tasks require an explanation',
          })
        if (task.done && ['blocked', 'deferred', 'discarded'].includes(task.status ?? ''))
          ctx.addIssue({ code: 'custom', message: 'Unfinished work cannot be marked completed' })
        let parent = task.parentId,
          depth = 0
        const seen = new Set([task.id])
        while (parent) {
          if (seen.has(parent) || !ids.has(parent) || ++depth > 8) {
            ctx.addIssue({ code: 'custom', message: 'Invalid task dependencies' })
            break
          }
          seen.add(parent)
          parent = goal.tasks.find((row) => row.id === parent)?.parentId
        }
      }
    }
  })
export const goalBookSchema = rawGoalBookSchema.transform(
  (value) => JSON.parse(JSON.stringify(value)) as typeof value,
)
export type GoalBook = z.infer<typeof goalBookSchema>
export type ManagedGoal = z.infer<typeof entrySchema>
export type GoalSettings = z.infer<typeof goalSettingsSchema>
