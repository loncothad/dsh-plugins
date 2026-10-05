import { z } from 'zod'
import type { PlanStep, SisyphusPlan } from './types.ts'
export const planSchema = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    goalId: z.string().min(1).max(256),
    title: z.string().min(1).max(4096),
    steps: z
      .array(
        z
          .object({
            title: z.string().min(1).max(1024),
            acceptance: z.string().min(1).max(2048),
            evidence: z.string().min(1).max(8192).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    index: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    phase: z.enum(['active', 'review', 'paused', 'blocked', 'complete']),
    pendingEvidence: z.string().min(1).max(8192).optional(),
    notice: z.string().max(2048).optional(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (
      (plan.phase === 'review') !== Boolean(plan.pendingEvidence) ||
      plan.index > plan.steps.length ||
      (plan.phase === 'complete') !== (plan.index === plan.steps.length) ||
      plan.steps.some((step, index) => index < plan.index !== Boolean(step.evidence))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid ordered checkpoint' })
  })
export function parseSteps(raw: string, limit: number): { title: string; steps: PlanStep[] } {
  if (raw.length > 32768) throw new Error('Plan exceeds 32 KiB')
  if (raw.trim().startsWith('{')) {
    const input = z
      .object({
        title: z.string().min(1).max(4096),
        steps: z
          .array(
            z
              .object({
                title: z.string().min(1).max(1024),
                acceptance: z.string().min(1).max(2048),
              })
              .strict(),
          )
          .min(1)
          .max(limit),
      })
      .strict()
      .parse(JSON.parse(raw))
    return input
  }
  const separator = raw.indexOf('::')
  if (separator < 1) throw new Error('Use /sisyphus Goal :: Step | acceptance; Step | acceptance')
  const title = raw.slice(0, separator).trim(),
    lines = raw
      .slice(separator + 2)
      .split(/;|\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  if (!title || title.length > 4096 || !lines.length || lines.length > limit)
    throw new Error(`Choose an objective and 1–${limit} steps`)
  const steps = lines.map((line) => {
    const [name, ...rest] = line.replace(/^\d+[.)]\s*/, '').split('|')
    const title = name!.trim(),
      acceptance = rest.join('|').trim()
    if (!title || title.length > 1024 || !acceptance || acceptance.length > 2048)
      throw new Error('Every step needs a title and an acceptance criterion, separated by |')
    return { title, acceptance }
  })
  return { title, steps }
}
export function advance(
  plan: SisyphusPlan,
  revision: number,
  evidence: string,
  maxEvidence: number,
): SisyphusPlan {
  if (plan.revision !== revision)
    throw new Error('Plan changed. Reload before updating this checkpoint.')
  if (plan.phase !== 'active') throw new Error('Resume the plan before completing a step')
  const text = evidence.trim()
  if (!text || text.length > maxEvidence)
    throw new Error(`Completion evidence must contain 1–${maxEvidence} characters`)
  const steps = plan.steps.map((step, index) =>
      index === plan.index ? { ...step, evidence: text } : step,
    ),
    index = plan.index + 1
  const { pendingEvidence: _proposal, ...retained } = plan
  return planSchema.parse({
    ...retained,
    steps,
    index,
    revision: revision + 1,
    failures: 0,
    phase: index === steps.length ? 'complete' : 'active',
  })
}
export function stepObjective(plan: Pick<SisyphusPlan, 'title' | 'steps' | 'index'>): string {
  const step = plan.steps[plan.index]
  return `[Sisyphus] ${plan.title}\nStep ${plan.index + 1}/${plan.steps.length}: ${step?.title ?? 'All steps finished'}\nAcceptance: ${step?.acceptance ?? 'Review recorded evidence'}\nWork on this step only. Report evidence through sisyphus_step or await human checkpoint approval. Do not bypass the ordered plan using update_goal.`
}

/** Current acceptance criteria stay whole; completed evidence consumes only remaining space. */
export function renderPlanContext(plan: SisyphusPlan, limit: number): string {
  const current = plan.steps[plan.index]
  let text = `Ordered goal: ${plan.title}\nState: ${plan.phase}; checkpoint revision ${plan.revision}; step ${plan.index + 1}/${plan.steps.length}.\nCurrent step: ${current?.title ?? 'Completed'}\nAcceptance: ${current?.acceptance ?? 'All checkpoints recorded'}`
  const completed = plan.steps.slice(0, plan.index)
  for (const step of completed.toReversed()) {
    const line = `\nCompleted step (evidence data): ${step.title} — ${step.evidence}`
    if (text.length + line.length + 100 > limit) {
      text +=
        '\nEarlier evidence omitted from this request; inspect get_sisyphus for the complete ordered goal.'
      break
    }
    text += line
  }
  return text
}
