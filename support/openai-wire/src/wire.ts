/**
 * Neutral wire vocabulary for OpenAI-style chat protocols. Pure domain
 * types with no harness imports: adapters map their harness message shapes
 * onto these, and the builders/parsers in this package speak only these.
 *
 * @module @loncothad/dsh-openai-wire/wire
 */

/** Roles a mapped message may carry on the wire. */
export type WireRole = 'system' | 'user' | 'assistant' | 'tool'

/** One assistant-requested tool invocation on the wire. */
export interface WireToolCall {
  readonly id: string
  readonly name: string
  /** Raw JSON argument string, assembled from streamed fragments. */
  readonly arguments: string
}

/** One mapped conversation message ready for a wire body. */
export interface WireMessage {
  readonly role: WireRole
  /** Concatenated text parts; omitted when the message carries none. */
  readonly text?: string
  readonly images?: readonly { data: string; mediaType: string }[]
  /** Assistant tool invocations, assistant messages only. */
  readonly toolCalls?: readonly WireToolCall[]
  /** Tool-role messages: the call id this result answers. */
  readonly toolCallId?: string
}

/** One tool declaration in the wire's function-tool shape. */
export interface WireToolSchema {
  readonly name: string
  readonly description: string
  /** JSON Schema object for the arguments. */
  readonly parameters: Record<string, unknown>
}

/** Disjoint token accounting, matching the harness usage contract. */
export interface WireUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** One neutral request, protocol-agnostic; builders project it per wire. */
export interface WireRequest {
  readonly model: string
  readonly messages: readonly WireMessage[]
  readonly tools?: readonly WireToolSchema[]
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
  /**
   * Vendor reasoning-effort wire value, already provider-shaped by the
   * adapter (Z.AI/GLM manages thinking server-side and omits it).
   */
  readonly reasoningEffort?: string
  /** OpenAI service tier (`priority` selects fast-mode handling). */
  readonly serviceTier?: string
  /** Additional top-level body fields the route needs (e.g. `originator`). */
  readonly extraBody?: Readonly<Record<string, unknown>>
}

/** Neutral streaming events emitted by wire parsers. */
export type WireEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | {
      readonly type: 'tool-call-start'
      readonly index: number
      readonly id: string
      readonly name: string
    }
  | { readonly type: 'tool-call-delta'; readonly index: number; readonly delta: string }
  | { readonly type: 'usage'; readonly usage: WireUsage }
  | {
      readonly type: 'finish'
      readonly reason: 'stop' | 'tool-calls' | 'max-tokens'
      /** Provider response id and model, for replay/diagnostics. */
      readonly response?: { readonly id?: string; readonly model?: string }
    }

/** Map a provider finish string onto the neutral vocabulary. */
export function wireFinishReason(
  raw: string | null | undefined,
): 'stop' | 'tool-calls' | 'max-tokens' | undefined {
  if (raw === 'stop' || raw === 'end_turn') return 'stop'
  if (raw === 'tool_calls' || raw === 'function_call') return 'tool-calls'
  if (raw === 'length' || raw === 'max_tokens') return 'max-tokens'
  return undefined
}
