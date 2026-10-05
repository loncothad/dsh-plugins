import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
export const receiptSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    fromSeq: z.number().int().min(0),
    throughSeq: z.number().int().min(0),
    requestThrough: z.number().int().min(-1),
    text: z.string().min(1).max(65536).optional(),
    externalRef: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    origin: z.enum(['local', 'external-model']),
    provider: z.string().max(256).optional(),
    model: z.string().max(256).optional(),
    trigger: z.enum(['manual', 'turns', 'decision', 'model-request']),
    turns: z.number().int().min(0),
    pending: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (row) =>
      row.throughSeq >= row.fromSeq &&
      (row.origin === 'local'
        ? Boolean(row.text) && !row.externalRef
        : !row.text && Boolean(row.externalRef)),
  )
export type Receipt = z.infer<typeof receiptSchema>
export const stateSchema = z
  .object({
    deliveries: z.array(receiptSchema).max(32),
    cursor: z.number().int().min(-1),
    calls: z.number().int().min(0),
    evaluatedThrough: z.number().int().min(-1),
    requestThrough: z.number().int().min(-1),
    deliveredRequestThrough: z.number().int().min(-1),
    latest: receiptSchema.nullable(),
    error: z.string().max(512).nullable(),
  })
  .strict()
export type SummaryState = z.infer<typeof stateSchema>
export const initialState = (): SummaryState => ({
  deliveries: [],
  cursor: -1,
  calls: 0,
  evaluatedThrough: -1,
  requestThrough: -1,
  deliveredRequestThrough: -1,
  latest: null,
  error: null,
})
export function foldSummary(
  state: SummaryState,
  event: { type: string; data: unknown; seq: number },
): SummaryState {
  if (event.type === 'conversation-summary/delivered') {
    const row = receiptSchema.parse(event.data)
    if (row.fromSeq !== state.cursor + 1 || row.throughSeq <= state.cursor)
      throw new Error('Invalid summary coverage sequence')
    const deliveries = [...state.deliveries, row].slice(-32)
    while (
      deliveries.length > 1 &&
      new TextEncoder().encode(JSON.stringify(deliveries)).length > 98304
    )
      deliveries.shift()
    return {
      ...state,
      deliveries,
      cursor: row.throughSeq,
      latest: row,
      error: null,
      deliveredRequestThrough: row.requestThrough,
    }
  }
  if (event.type === 'conversation-summary/attempt') return { ...state, calls: state.calls + 1 }
  if (event.type === 'conversation-summary/evaluated')
    return {
      ...state,
      evaluatedThrough: Math.max(
        state.evaluatedThrough,
        Number((event.data as { throughSeq: number }).throughSeq),
      ),
    }
  if (event.type === 'conversation-summary/request') return { ...state, requestThrough: event.seq }
  if (event.type === 'conversation-summary/failure')
    return { ...state, error: String((event.data as { message: string }).message).slice(0, 512) }
  return state
}
export interface Window {
  fromSeq: number
  throughSeq: number
  turns: number
  pending: boolean
  body: string
}
/** Only message evidence enters auxiliary calls. Custom cards, credentials, settings and request headers are excluded. */
function evidence(event: SessionEvent): string | undefined {
  if (!['user/message', 'assistant/message', 'tool/result', 'tool/call'].includes(event.type))
    return undefined
  if (event.type === 'tool/call')
    return JSON.stringify({
      seq: event.seq,
      role: 'tool-call',
      name: event.data.name,
      arguments: event.data.arguments,
    })
  const data = event.data as Record<string, unknown>,
    message = (data.message ?? data) as { content?: unknown[]; role?: string; isError?: boolean }
  const content = (message.content ?? []).map((block) => {
    if (!block || typeof block !== 'object') return { type: 'unavailable' }
    const value = block as Record<string, unknown>
    if (value.type === 'text') return { type: 'text', text: value.text }
    if (value.type === 'tool-call')
      return { type: 'tool-call', name: value.name, arguments: value.arguments }
    return { type: String(value.type), omitted: true }
  })
  return JSON.stringify({
    seq: event.seq,
    role: event.type,
    content,
    ...(message.isError ? { isError: true } : {}),
  })
}
export function collectWindow(
  events: readonly SessionEvent[],
  cursor: number,
  limit: number,
): Window | undefined {
  const boundary = events.findLast((event) => event.type === 'turn/end')?.seq
  if (boundary === undefined || boundary <= cursor) return undefined
  const lines: string[] = [],
    fromSeq = cursor + 1
  let bytes = 2,
    throughSeq = cursor,
    turns = 0,
    pending = false
  for (const event of events) {
    if (event.seq <= cursor || event.seq > boundary) continue
    const line = evidence(event)
    if (line !== undefined && bytes + line.length + 1 > limit) {
      if (!lines.length)
        throw new Error(
          `Event ${event.seq} exceeds the summary input limit. Increase the limit or summarize a smaller session.`,
        )
      pending = true
      break
    }
    if (line !== undefined) {
      lines.push(line)
      bytes += line.length + 1
    }
    throughSeq = event.seq
    if (event.type === 'turn/end') turns++
  }
  if (!lines.length) return undefined
  return { fromSeq, throughSeq, turns, pending, body: `[${lines.join(',\n')}]` }
}
export function decisionAnswer(text: string): 'SEND' | 'WAIT' {
  const answer = text.trim()
  if (answer !== 'SEND' && answer !== 'WAIT')
    throw new Error('The decision model must return exactly SEND or WAIT')
  return answer
}
export function localDigest(window: Window, limit: number): string {
  const rows = JSON.parse(window.body) as {
    seq: number
    role: string
    content?: { text?: string; type: string }[]
    name?: string
    arguments?: string
  }[]
  const budget = Math.max(24, Math.floor((limit - 256) / Math.max(rows.length, 1)) - 80)
  const lines = rows.map((row) => {
    const full =
      row.content?.map((block) => block.text ?? `[${block.type} omitted]`).join(' ') ??
      `${row.name ?? 'tool'} ${row.arguments ?? ''}`
    return `- [${row.seq}] ${row.role}: ${full.length > budget ? `${full.slice(0, budget)} … [excerpt]` : full}`
  })
  const full = `Local transcript digest · events ${window.fromSeq}–${window.throughSeq}\nExcerpts of the covered events; consult the original conversation for complete text.\n\n${lines.join('\n')}`
  return full.length > limit ? `${full.slice(0, limit - 32)}\n[Remaining excerpts omitted]` : full
}
