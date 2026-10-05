/**
 * OpenAI Responses wire (the ChatGPT Codex backend protocol): request-body
 * projection and streaming event parsing for the neutral vocabulary.
 *
 * @module @loncothad/dsh-openai-wire/responses
 */

import type { WireEvent, WireRequest, WireUsage } from './wire.ts'

/** Instructions and input items of a projected Responses request. */
export interface ResponsesBody {
  readonly model: string
  readonly instructions: string
  readonly input: readonly Record<string, unknown>[]
  readonly tools: readonly Record<string, unknown>[]
  readonly stream: boolean
  readonly [key: string]: unknown
}

/**
 * Project one neutral request onto the Responses body. The leading system
 * material becomes `instructions`; conversation history becomes typed
 * input items; tool results answer their calls as `function_call_output`.
 */
export function buildResponsesBody(request: WireRequest): ResponsesBody {
  const instructions: string[] = []
  const input: Record<string, unknown>[] = []
  for (const message of request.messages) {
    switch (message.role) {
      case 'system':
        if (message.text !== undefined) instructions.push(message.text)
        break
      case 'user':
        input.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: message.text ?? '' }],
        })
        break
      case 'assistant': {
        if (message.text !== undefined && message.text.length > 0) {
          input.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: message.text }],
          })
        }
        for (const call of message.toolCalls ?? []) {
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: call.arguments,
          })
        }
        break
      }
      case 'tool':
        input.push({
          type: 'function_call_output',
          call_id: message.toolCallId ?? '',
          output: message.text ?? '',
        })
        break
    }
  }
  const body: ResponsesBody = {
    model: request.model,
    instructions: instructions.join('\n\n'),
    input,
    tools: (request.tools ?? []).map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    stream: true,
  }
  const extra: Record<string, unknown> = { ...(request.extraBody ?? {}) }
  if (request.maxTokens !== undefined) extra.max_output_tokens = request.maxTokens
  if (request.temperature !== undefined) extra.temperature = request.temperature
  if (request.reasoningEffort !== undefined) {
    extra.reasoning = { effort: request.reasoningEffort }
  }
  if (request.serviceTier !== undefined) extra.service_tier = request.serviceTier
  return { ...body, ...extra }
}

/** Usage block of a Responses `response.completed` event. */
interface ResponsesUsage {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly total_tokens?: number
  readonly input_tokens_details?: { readonly cached_tokens?: number }
  readonly output_tokens_details?: { readonly reasoning_tokens?: number }
}

/** One parsed Responses stream event. */
export interface ResponsesStreamEvent {
  readonly type: string
  readonly delta?: string
  readonly output_index?: number
  readonly item?: {
    readonly type?: string
    readonly id?: string
    readonly call_id?: string
    readonly name?: string
  }
  readonly response?: {
    readonly id?: string
    readonly model?: string
    readonly usage?: ResponsesUsage | null
    readonly incomplete_details?: { readonly reason?: string }
    readonly error?: { readonly message?: string }
  }
}

function mapResponsesUsage(usage: ResponsesUsage | null | undefined): WireUsage | undefined {
  if (usage === undefined || usage === null) return undefined
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheRead = usage.input_tokens_details?.cached_tokens
  return {
    inputTokens: cacheRead !== undefined ? Math.max(0, input - cacheRead) : input,
    outputTokens: output,
    totalTokens: usage.total_tokens ?? input + output,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined
      ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens }
      : {}),
  }
}

/**
 * Translate one Responses stream event into neutral events. Reasoning
 * summary and reasoning text deltas both map to reasoning; function-call
 * argument deltas map to tool-call fragments at the item's output index.
 */
export function parseResponsesEvent(event: ResponsesStreamEvent): WireEvent[] {
  const events: WireEvent[] = []
  switch (event.type) {
    case 'response.output_text.delta':
      if (typeof event.delta === 'string' && event.delta.length > 0) {
        events.push({ type: 'text-delta', text: event.delta })
      }
      break
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      if (typeof event.delta === 'string' && event.delta.length > 0) {
        events.push({ type: 'reasoning-delta', text: event.delta })
      }
      break
    case 'response.output_item.added':
      if (event.item?.type === 'function_call' && event.item.call_id !== undefined) {
        events.push({
          type: 'tool-call-start',
          index: event.output_index ?? 0,
          id: event.item.call_id,
          name: event.item.name ?? '',
        })
      }
      break
    case 'response.function_call_arguments.delta':
      if (typeof event.delta === 'string' && event.delta.length > 0) {
        events.push({ type: 'tool-call-delta', index: event.output_index ?? 0, delta: event.delta })
      }
      break
    case 'response.completed': {
      const usage = mapResponsesUsage(event.response?.usage)
      if (usage !== undefined) events.push({ type: 'usage', usage })
      events.push({
        type: 'finish',
        reason: 'stop',
        response: {
          ...(event.response?.id !== undefined ? { id: event.response.id } : {}),
          ...(event.response?.model !== undefined ? { model: event.response.model } : {}),
        },
      })
      break
    }
    case 'response.incomplete': {
      const usage = mapResponsesUsage(event.response?.usage)
      if (usage !== undefined) events.push({ type: 'usage', usage })
      events.push({
        type: 'finish',
        reason:
          event.response?.incomplete_details?.reason === 'max_output_tokens'
            ? 'max-tokens'
            : 'stop',
        response: {
          ...(event.response?.id !== undefined ? { id: event.response.id } : {}),
          ...(event.response?.model !== undefined ? { model: event.response.model } : {}),
        },
      })
      break
    }
    default:
      // Lifecycle and bookkeeping events (offers, content-part boundaries)
      // carry no neutral content.
      break
  }
  return events
}
