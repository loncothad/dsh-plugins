import { z } from 'zod'
export const receiptSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    target: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(['source', 'database-read', 'verifier', 'model-verifier', 'human-review']),
    origin: z.string().min(1).max(4096),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    recordedAt: z.number().int().nonnegative(),
    passed: z.boolean(),
    verifierId: z.string().max(128).optional(),
  })
  .strict()
export const assuranceSchema = z
  .object({
    receipts: z.array(receiptSchema).max(256),
    calls: z.number().int().nonnegative(),
    candidate: z
      .object({ hash: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().min(1).max(16384) })
      .nullable(),
    workflow: z
      .object({
        id: z.string().min(1).max(128),
        contract: z.string().min(1).max(128),
        criteria: z.string().min(1).max(16384),
        phase: z.enum(['active', 'complete']),
        revision: z.number().int().positive(),
      })
      .nullable(),
  })
  .strict()
export type AssuranceState = z.infer<typeof assuranceSchema>
export const initial = (): AssuranceState => ({
  receipts: [],
  calls: 0,
  candidate: null,
  workflow: null,
})
export function foldAssurance(
  state: AssuranceState,
  event: { type: string; data: unknown },
): AssuranceState {
  if (event.type === 'evidence-assurance/receipt') {
    const receipt = receiptSchema.parse(event.data)
    return {
      ...state,
      receipts: [...state.receipts.filter((row) => row.id !== receipt.id), receipt].slice(-256),
    }
  }
  if (event.type === 'evidence-assurance/attempt') return { ...state, calls: state.calls + 1 }
  if (event.type === 'evidence-assurance/workflow')
    return { ...state, workflow: assuranceSchema.shape.workflow.parse(event.data) }
  if (event.type === 'evidence-assurance/candidate')
    return { ...state, candidate: assuranceSchema.shape.candidate.parse(event.data) }
  return state
}
