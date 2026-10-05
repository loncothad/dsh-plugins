import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { categories, findingSchema, type State } from './state.ts'

export type { Notice, State } from './state.ts'
export { initial, stateSchema } from './state.ts'
export const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export interface Evidence {
  id: string
  sessionId: string
  seq: number
  hash: string
  text: string
  truncated: boolean
  kind: string
}
export function redact(text: string): string {
  return text
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|fal_sk_[A-Za-z0-9_:.-]{12,})\b/g, '[credential redacted]')
    .replace(
      /((?:authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)[\\"'\s]*[=:][\\"'\s]*(?:Bearer\s+)?)([^\s\\"'`,;]+)/gi,
      '$1[redacted]',
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      '[private key redacted]',
    )
}
export function collect(
  events: readonly SessionEvent[],
  sessionId: string,
  cursor: number,
  limit: number,
  eventLimit: number,
  toolOutputs: boolean,
): { evidence: Evidence[]; through: number; omitted: number; hasMore: boolean } {
  const evidence: Evidence[] = []
  let bytes = 2,
    through = cursor,
    omitted = 0
  for (const event of events) {
    if (event.seq <= cursor) continue
    let text: string | undefined
    if (event.type === 'assistant/message')
      text = event.data.message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
    if (event.type === 'tool/call')
      text = JSON.stringify({ tool: event.data.name, arguments: event.data.arguments })
    if (event.type === 'tool/result' && toolOutputs)
      text = event.data.message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
    if (text) {
      const safe = redact(text.slice(0, eventLimit))
      const entry = {
        id: `${sessionId}:${event.seq}`,
        sessionId,
        seq: event.seq,
        hash: hash(safe),
        text: safe,
        truncated: text.length > eventLimit,
        kind: event.type,
      }
      let size = JSON.stringify(entry).length + 1
      if (bytes + size > limit) {
        if (evidence.length) break
        // A single large event must not permanently stall the coverage cursor.
        let low = 0,
          high = entry.text.length
        while (low < high) {
          const mid = Math.ceil((low + high) / 2)
          if (
            JSON.stringify({ ...entry, text: entry.text.slice(0, mid), truncated: true }).length +
              1 <=
            limit - bytes
          )
            low = mid
          else high = mid - 1
        }
        entry.text = entry.text.slice(0, low)
        entry.hash = hash(entry.text)
        entry.truncated = true
        size = JSON.stringify(entry).length + 1
        if (!low || bytes + size > limit) throw Error('Evidence metadata exceeds the review window')
      }
      evidence.push(entry)
      bytes += size
      if (entry.truncated) omitted++
    }
    through = event.seq
  }
  return { evidence, through, omitted, hasMore: (events.at(-1)?.seq ?? cursor) > through }
}
function sourceRef(row: Evidence) {
  return {
    sessionId: row.sessionId,
    kind: row.kind === 'workspace-diff' ? ('workspace-diff' as const) : ('session' as const),
    reference: row.id,
    ...(row.kind === 'workspace-diff' ? {} : { seq: row.seq }),
    hash: row.hash,
    quote: row.text.slice(0, 400),
  }
}
export function localFindings(evidence: readonly Evidence[]): z.infer<typeof findingSchema>[] {
  return evidence.flatMap((row) => {
    const text = row.text
    const weakened =
      /(?:tests?|spec|assert|expect)/i.test(text) &&
      (/\b(?:it|test|describe)\.(?:skip|todo)\s*\(/.test(text) ||
        /(?:^|\\n|\n)-(?!-).*\b(?:assert|expect)\s*\(/.test(text))
    const missing =
      /\b(?:did not|didn't|haven't|not yet|unable to|could not|couldn't|skipped)\s+(?:run|execute|verify|test)/i.test(
        text,
      ) ||
      /\b(?:tests?|verification)\s+(?:were |was |are )?(?:not run|skipped|unavailable)/i.test(text)
    const retry =
      /\b(?:payment|charge|billing)\b/i.test(text) &&
      /\bretr(?:y|ies|ied)\b/i.test(text) &&
      !/\bidempotenc/i.test(text)
    const category = weakened
      ? 'test_integrity'
      : missing
        ? 'verification'
        : retry
          ? 'retry_safety'
          : undefined
    if (!category) return []
    return [
      {
        title: weakened
          ? 'Test coverage may have been weakened'
          : missing
            ? 'Verification is still missing'
            : 'Payment retry needs duplicate-charge protection',
        severity: 'warning' as const,
        category,
        detail: weakened
          ? 'Observed text introduces a skipped test or removes an assertion. This is a review cue, not proof of intent or of a committed change.'
          : missing
            ? 'The recorded output says a verification step was not performed. A completion claim should retain that limitation.'
            : 'Recorded text mentions retrying a payment without describing idempotency. A lost response can differ from a failed charge.',
        nextAction: weakened
          ? 'Inspect the referenced change and confirm the original behavior remains tested.'
          : missing
            ? 'Run the missing check, or record why it is unavailable and what remains unverified.'
            : 'Verify request identity and payment-provider idempotency before repeating a charge.',
        sources: [sourceRef(row)],
      },
    ] as z.infer<typeof findingSchema>[]
  })
}
export function parseReview(
  text: string,
  evidence: readonly Evidence[],
): z.infer<typeof findingSchema>[] {
  const raw = z
    .object({
      findings: z
        .array(
          z
            .object({
              title: z.string().min(1).max(160),
              severity: z.enum(['info', 'warning', 'critical']),
              category: z.enum(categories),
              detail: z.string().min(1).max(1500),
              nextAction: z.string().min(1).max(512),
              sourceIds: z.array(z.string().min(1).max(512)).min(1).max(4),
            })
            .strict(),
        )
        .max(5),
    })
    .strict()
    .parse(JSON.parse(text))
  return raw.findings.map((row) => {
    const { sourceIds, ...finding } = row
    return findingSchema.parse({
      ...finding,
      sources: [...new Set(sourceIds)].map((id) => {
        const source = evidence.find((e) => e.id === id)
        if (!source) throw Error('Reviewer cited unavailable evidence')
        return sourceRef(source)
      }),
    })
  })
}
export function publish(
  state: State,
  findings: readonly z.infer<typeof findingSchema>[],
  origin: 'local' | 'model',
  max: number,
  route?: { provider: string; model: string },
): State {
  const notices = [...state.notices]
  for (const finding of findings) {
    const id = hash(
      JSON.stringify({
        category: finding.category,
        title: finding.title,
        sources: finding.sources.map((s) => ({
          sessionId: s.sessionId,
          reference: s.reference,
          hash: s.hash,
        })),
      }),
    )
    if (notices.some((n) => n.id === id)) continue
    notices.push({
      ...finding,
      id,
      origin,
      state: 'new',
      createdAt: new Date().toISOString(),
      ...route,
    })
  }
  while (notices.length > max || JSON.stringify(notices).length > 80000) notices.shift()
  return { ...state, notices }
}
