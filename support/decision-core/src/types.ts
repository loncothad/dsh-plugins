export type DecisionQuestion =
  | { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> }
  | { type: 'score'; instructions: unknown; criteria: unknown[] }
  | { type: 'noul'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
export interface DecisionInput {
  state: unknown
  questions: Record<string, DecisionQuestion>
  images?: (string | { content_type: string; base64: string })[]
}
export interface DecisionResult {
  model: string
  answers: Record<string, Record<string, unknown>>
  status: 'unverified'
  usage?: Record<string, number>
}
