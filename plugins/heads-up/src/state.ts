import { z } from 'zod'
export const categories = [
  'test_integrity',
  'verification',
  'retry_safety',
  'scope',
  'contradiction',
  'other',
] as const
export const sourceSchema = z
  .object({
    sessionId: z.string().max(128),
    kind: z.enum(['session', 'workspace-diff']),
    reference: z.string().max(512),
    seq: z.number().int().min(0).optional(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    quote: z.string().max(400),
  })
  .strict()
export const findingSchema = z
  .object({
    title: z.string().min(1).max(160),
    severity: z.enum(['info', 'warning', 'critical']),
    category: z.enum(categories),
    detail: z.string().min(1).max(1500),
    nextAction: z.string().min(1).max(512),
    sources: z.array(sourceSchema).min(1).max(4),
  })
  .strict()
export const noticeSchema = findingSchema
  .extend({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    origin: z.enum(['local', 'model']),
    state: z.enum(['new', 'acknowledged', 'dismissed', 'discussed']),
    createdAt: z.string().datetime(),
    provider: z.string().max(256).optional(),
    model: z.string().max(512).optional(),
  })
  .strict()
export type Notice = z.infer<typeof noticeSchema>
export const stateSchema = z
  .object({
    revision: z.number().int().min(0),
    paused: z.boolean(),
    notices: z.array(noticeSchema).max(32),
    streams: z.record(z.string(), z.number().int().min(-1)),
    calls: z.number().int().min(0),
    reservedUsd: z.number().finite().min(0),
    lastReviewAt: z.string().nullable(),
    error: z.string().max(512).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (JSON.stringify(value).length > 98304 || Object.keys(value.streams).length > 128)
      ctx.addIssue({ code: 'custom', message: 'Heads Up state exceeds its bound' })
  })
export type State = z.infer<typeof stateSchema>
export const initial = (): State => ({
  revision: 0,
  paused: false,
  notices: [],
  streams: {},
  calls: 0,
  reservedUsd: 0,
  lastReviewAt: null,
  error: null,
})
