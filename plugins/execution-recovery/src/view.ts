import { z } from 'zod'
export const jobView = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.string().min(1).max(64),
    status: z.enum(['queued', 'running', 'complete', 'dead']),
    attempts: z.number().int().min(0).max(16),
    maxAttempts: z.number().int().min(1).max(16),
    leaseUntil: z.number().int().nullable(),
    reason: z.string().max(512).nullable(),
    retrySafe: z.boolean(),
  })
  .strict()
export type JobView = z.infer<typeof jobView>
export const recoveryView = z.array(jobView).max(32)
