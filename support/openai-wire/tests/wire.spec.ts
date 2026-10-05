import { describe, expect, it } from 'vitest'
import { buildCompletionsBody, parseCompletionsChunk } from '../src/completions.ts'
import { buildResponsesBody, parseResponsesEvent } from '../src/responses.ts'
import { SseDecoder } from '../src/sse.ts'
import type { WireRequest } from '../src/wire.ts'

const request: WireRequest = {
  model: 'glm-5.3',
  messages: [
    { role: 'system', text: 'be brief' },
    { role: 'user', text: 'hello' },
    {
      role: 'assistant',
      text: 'hi',
      toolCalls: [{ id: 'call_1', name: 'search', arguments: '{"q":"x"}' }],
    },
    { role: 'tool', toolCallId: 'call_1', text: 'result text' },
  ],
  tools: [{ name: 'search', description: 'search the web', parameters: { type: 'object' } }],
  maxTokens: 128,
  stop: ['END'],
}

describe('sse decoding', () => {
  it('decodes events split across arbitrary chunk boundaries', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('data: {"a":1}\n\ndata: [DONE]')).toEqual([JSON.stringify({ a: 1 })])
    expect(decoder.push('\n\n')).toEqual(['[DONE]'])
    expect(decoder.flush()).toEqual([])
  })

  it('joins multi-line data fields and ignores non-data fields', () => {
    const decoder = new SseDecoder()
    const out = decoder.push('event: x\nid: 1\ndata: line1\ndata: line2\n\n')
    expect(out).toEqual(['line1\nline2'])
  })

  it('tolerates crlf line endings and flushes trailing events', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('data: one\r\n\r\n')).toEqual(['one'])
    expect(decoder.push('data: two\r\n\r\n')).toEqual(['two'])
    expect(decoder.flush()).toEqual([])
    const trailing = new SseDecoder()
    expect(trailing.push('data: tail\n')).toEqual([])
    expect(trailing.flush()).toEqual(['tail'])
  })
})

describe('chat completions wire', () => {
  it('projects the neutral request with max_tokens and no reasoning field', () => {
    const body = buildCompletionsBody(request) as Record<string, unknown>
    expect(body.model).toBe('glm-5.3')
    expect(body.max_tokens).toBe(128)
    expect(body.stop).toEqual(['END'])
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.stream).toBe(true)
    expect(body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: 'hi',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'result text' },
    ])
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'search', description: 'search the web', parameters: { type: 'object' } },
      },
    ])
  })

  it('merges extra body fields last', () => {
    const body = buildCompletionsBody({ ...request, extraBody: { originator: 'dsh' } })
    expect((body as Record<string, unknown>).originator).toBe('dsh')
  })

  it('parses text, reasoning, tool fragments, disjoint usage, and finish', () => {
    const events = [
      ...parseCompletionsChunk({
        choices: [{ delta: { reasoning_content: 'thinking' } }],
      }),
      ...parseCompletionsChunk({
        choices: [
          {
            delta: {
              content: 'hi',
              tool_calls: [{ index: 0, id: 'c1', function: { name: 'search', arguments: '{"' } }],
            },
          },
        ],
      }),
      ...parseCompletionsChunk({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'q":1}' } }] } }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 3,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      }),
      ...parseCompletionsChunk({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        id: 'resp_9',
        model: 'glm-5.3',
      }),
    ]
    expect(events).toEqual([
      { type: 'reasoning-delta', text: 'thinking' },
      { type: 'text-delta', text: 'hi' },
      { type: 'tool-call-start', index: 0, id: 'c1', name: 'search' },
      { type: 'tool-call-delta', index: 0, delta: '{"' },
      { type: 'tool-call-delta', index: 0, delta: 'q":1}' },
      {
        type: 'usage',
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 15, cacheReadTokens: 4 },
      },
      { type: 'finish', reason: 'tool-calls', response: { id: 'resp_9', model: 'glm-5.3' } },
    ])
  })

  it('maps length finishes to max-tokens', () => {
    expect(parseCompletionsChunk({ choices: [{ delta: {}, finish_reason: 'length' }] })).toEqual([
      { type: 'finish', reason: 'max-tokens', response: {} },
    ])
  })
})

describe('responses wire', () => {
  it('projects instructions, input items, and function tools', () => {
    const body = buildResponsesBody(request)
    expect(body.instructions).toBe('be brief')
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
      { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result text' },
    ])
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'search',
        description: 'search the web',
        parameters: { type: 'object' },
      },
    ])
    expect(body.stream).toBe(true)
  })

  it('carries effort, service tier, and output limit', () => {
    const body = buildResponsesBody({
      model: 'gpt-x',
      messages: [{ role: 'user', text: 'q' }],
      reasoningEffort: 'high',
      serviceTier: 'priority',
      maxTokens: 64,
    })
    expect((body as Record<string, unknown>).reasoning).toEqual({ effort: 'high' })
    expect((body as Record<string, unknown>).service_tier).toBe('priority')
    expect((body as Record<string, unknown>).max_output_tokens).toBe(64)
  })

  it('parses reasoning, text, tool-call events, and completed usage', () => {
    const events = [
      ...parseResponsesEvent({ type: 'response.reasoning_summary_text.delta', delta: 'sum' }),
      ...parseResponsesEvent({ type: 'response.output_text.delta', delta: 'answer' }),
      ...parseResponsesEvent({
        type: 'response.output_item.added',
        output_index: 2,
        item: { type: 'function_call', call_id: 'call_7', name: 'run' },
      }),
      ...parseResponsesEvent({
        type: 'response.function_call_arguments.delta',
        output_index: 2,
        delta: '{"a":1}',
      }),
      ...parseResponsesEvent({
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: 'gpt-x',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 6 },
          },
        },
      }),
    ]
    expect(events).toEqual([
      { type: 'reasoning-delta', text: 'sum' },
      { type: 'text-delta', text: 'answer' },
      { type: 'tool-call-start', index: 2, id: 'call_7', name: 'run' },
      { type: 'tool-call-delta', index: 2, delta: '{"a":1}' },
      {
        type: 'usage',
        usage: { inputTokens: 4, outputTokens: 5, totalTokens: 15, cacheReadTokens: 6 },
      },
      { type: 'finish', reason: 'stop', response: { id: 'resp_1', model: 'gpt-x' } },
    ])
  })

  it('maps incomplete max-output responses to max-tokens', () => {
    const events = parseResponsesEvent({
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'max_output_tokens' } },
    })
    expect(events).toEqual([{ type: 'finish', reason: 'max-tokens', response: {} }])
  })
})
