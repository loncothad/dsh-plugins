/**
 * OpenAI Chat Completions wire: request-body projection and streaming
 * response parsing for the neutral vocabulary.
 *
 * @module @loncothad/dsh-openai-wire/completions
 */

import type { WireEvent, WireRequest, WireUsage } from './wire.ts'
import { wireFinishReason } from './wire.ts'

/** One assistant delta as it appears in `choices[0].delta`. */
interface CompletionsDelta {
  readonly content?: string | null
  /** DeepSeek-style separated reasoning channel. */
  readonly reasoning_content?: string | null
  readonly reasoning?: string | null
  readonly tool_calls?: readonly {
    readonly index?: number
    readonly id?: string
    readonly function?: { readonly name?: string; readonly arguments?: string }
  }[]
}

/** One parsed chunk of a streaming chat-completions response. */
export interface CompletionsChunk {
  readonly choices?: readonly {
    readonly delta?: CompletionsDelta
    readonly finish_reason?: string | null
  }[]
  readonly usage?: {
    readonly prompt_tokens?: number
    readonly completion_tokens?: number
    readonly total_tokens?: number
    readonly prompt_tokens_details?: {
      readonly cached_tokens?: number
      readonly cache_read_tokens?: number
    }
    readonly completion_tokens_details?: { readonly reasoning_tokens?: number }
  } | null
  readonly model?: string
  readonly id?: string
}

/** Static body fields every route can shape further via `extraBody`. */
export interface CompletionsBodyOptions {
  /** Additional top-level fields merged last (originator, session_id, ...). */
  readonly extraBody?: Readonly<Record<string, unknown>>
}

/**
 * Project one neutral request onto the chat-completions body. `max_tokens`
 * (not `max_output_tokens`) carries the output limit, and no reasoning
 * field is emitted unless the adapter supplied one — the Z.AI/GLM coding
 * plans manage thinking server-side.
 */
export function buildCompletionsBody(
  request: WireRequest,
  options: CompletionsBodyOptions = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((message) => {
      const mapped: Record<string, unknown> = { role: message.role }
      if (message.text !== undefined && message.text.length > 0) {
        mapped.content = message.text
      }
      if (message.images?.length)
        mapped.content = [
          ...(message.text ? [{ type: 'text', text: message.text }] : []),
          ...message.images.map((image) => ({
            type: 'image_url',
            image_url: { url: `data:${image.mediaType};base64,${image.data}` },
          })),
        ]
      if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
        mapped.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }))
      }
      if (message.toolCallId !== undefined) {
        mapped.tool_call_id = message.toolCallId
      }
      return mapped
    }),
    stream: true,
    stream_options: { include_usage: true },
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
  }
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
  if (request.stop !== undefined && request.stop.length > 0) body.stop = [...request.stop]
  if (request.reasoningEffort !== undefined) body.reasoning_effort = request.reasoningEffort
  if (request.serviceTier !== undefined) body.service_tier = request.serviceTier
  return { ...body, ...(request.extraBody ?? {}), ...(options.extraBody ?? {}) }
}

/** Map provider usage fields onto the disjoint neutral accounting. */
export function mapCompletionsUsage(chunk: CompletionsChunk): WireUsage | undefined {
  const usage = chunk.usage
  if (usage === undefined || usage === null) return undefined
  const input = usage.prompt_tokens ?? 0
  const output = usage.completion_tokens ?? 0
  const cacheRead =
    usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cache_read_tokens
  const total = usage.total_tokens ?? input + output
  return {
    inputTokens: cacheRead !== undefined ? Math.max(0, input - cacheRead) : input,
    outputTokens: output,
    totalTokens: total,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(usage.completion_tokens_details?.reasoning_tokens !== undefined
      ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }
      : {}),
  }
}

/**
 * Translate one parsed streaming chunk into neutral events. Tool-call
 * fragments carry the provider's per-call index so the adapter can spread
 * concurrent calls across harness block indexes.
 */
export function parseCompletionsChunk(chunk: CompletionsChunk): WireEvent[] {
  const events: WireEvent[] = []
  const choice = chunk.choices?.[0]
  const delta = choice?.delta
  if (delta !== undefined) {
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      events.push({ type: 'reasoning-delta', text: reasoning })
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      events.push({ type: 'text-delta', text: delta.content })
    }
    for (const fragment of delta.tool_calls ?? []) {
      const index = fragment.index ?? 0
      if (fragment.id !== undefined && fragment.function?.name !== undefined) {
        events.push({
          type: 'tool-call-start',
          index,
          id: fragment.id,
          name: fragment.function.name,
        })
      }
      const args = fragment.function?.arguments
      if (args !== undefined && args.length > 0) {
        events.push({ type: 'tool-call-delta', index, delta: args })
      }
    }
  }
  const usage = mapCompletionsUsage(chunk)
  if (usage !== undefined) events.push({ type: 'usage', usage })
  const finish = wireFinishReason(choice?.finish_reason)
  if (finish !== undefined) {
    events.push({
      type: 'finish',
      reason: finish,
      response: {
        ...(chunk.id !== undefined ? { id: chunk.id } : {}),
        ...(chunk.model !== undefined ? { model: chunk.model } : {}),
      },
    })
  }
  return events
}
