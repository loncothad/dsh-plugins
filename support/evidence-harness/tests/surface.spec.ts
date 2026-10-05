import { Context } from '@deepseek-ai/cordis'
import { CompactionId, isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import * as CompactionInvariant from '@deepseek-ai/dsh-compaction/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionStore, { isSurfaceEvent, Session, SessionId } from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import type { SessionLogSnapshot, SessionSurfaceSnapshot } from '@deepseek-ai/dsh-session-query'
import { expect, it } from 'vitest'
import type { NativeCommitInput } from '../src/index.ts'
import {
  commitNativeRange,
  commitObservationMasks,
  nativeSurfaceUnits,
  observationMasks,
} from '../src/index.ts'

function fixture() {
  const session = Session.create(SessionId('native-surface'))
  const events: SessionEvent[] = []
  const user = (text: string) => {
    const event = session.append(
      'user/message',
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
      { surfaceOp: 'append' },
    )
    events.push(event)
    return event
  }
  const assistant = (calls = false) => {
    const event = session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        stream: [],
        message: createAssistantMessage({
          source: { provider: 'fixture', model: 'model' },
          content: calls
            ? [{ type: 'tool-call', id: ToolCallId('call'), name: 'read', arguments: '{}' }]
            : [{ type: 'text', text: 'An old answer '.repeat(100) }],
        }),
      },
      { surfaceOp: 'append' },
    )
    events.push(event)
    return event
  }
  const result = (text = 'An original observation '.repeat(100)) => {
    const event = session.append(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('call'),
          content: [{ type: 'text', text }],
          isError: false,
        }),
      },
      { surfaceOp: 'append' },
    )
    events.push(event)
    return event
  }
  const surface = (): SessionSurfaceSnapshot => ({
    session: session.header,
    inheritedEventCount: session.inheritedEventCount,
    capturedThroughSeq: events.at(-1)?.seq ?? null,
    events: events
      .filter(isSurfaceEvent)
      .filter((event) => session.surface.nodes.includes(event.seq)),
  })
  const log = (): SessionLogSnapshot => ({
    session: session.header,
    inheritedEventCount: session.inheritedEventCount,
    events: [...events],
  })
  const input = (shadowedSeqs: SessionSeq[]): NativeCommitInput => ({
    session,
    surface: surface(),
    log: log(),
    mode: 'manual',
    shadowedSeqs,
    shadowedTokenCount: 500,
    memory: 'Original evidence remains available through scoped retrieval.',
    signal: new AbortController().signal,
  })
  return { session, events, user, assistant, result, surface, log, input }
}

it('groups complete tool dependencies and keeps instructions, latest input, pins, and open groups mandatory', () => {
  const f = fixture()
  f.events.push(
    f.session.append(
      'system/message',
      { turn: 1, step: 1, message: createSystemMessage('Instruction') },
      { surfaceOp: 'append' },
    ),
  )
  const old = f.user('Older input')
  const call = f.assistant(true)
  const result = f.result()
  const latest = f.user('Latest exact request')
  f.assistant(true)
  const units = nativeSurfaceUnits(f.session, f.surface())
  expect(units[0]).toMatchObject({ kind: 'instructions', mandatory: true })
  expect(units[1]).toMatchObject({
    kind: 'interaction',
    closed: true,
    mandatory: false,
    content: { seqs: [old.seq, call.seq, result.seq] },
  })
  expect(units[2]).toMatchObject({ kind: 'latest-user', closed: false, mandatory: true })
  expect(units[2]?.content.seqs).toContain(latest.seq)
  expect(nativeSurfaceUnits(f.session, f.surface(), new Set([old.seq]))[1]).toMatchObject({
    kind: 'pin',
    mandatory: true,
  })
})

it('publishes a balanced native checkpoint with a complete durable bracket while preserving latest user input', () => {
  const f = fixture()
  const old = f.user('Older original input')
  const answer = f.assistant()
  f.user('Keep this latest user request verbatim.')
  const result = commitNativeRange(f.input([old.seq, answer.seq]))
  expect(result).toMatchObject({ shadowedSeqs: [old.seq, answer.seq], shadowedTokenCount: 500 })
  expect(result.endSeq - result.startSeq).toBe(3)
  const messages = f.session.deriveMessages()
  expect(messages).toHaveLength(2)
  expect(isCompactCheckpointSource(messages[0]!.source)).toBe(true)
  expect(messages[1]?.content).toEqual([
    { type: 'text', text: 'Keep this latest user request verbatim.' },
  ])
  expect(f.session.surface.nodes).not.toContain(old.seq)
})

it('refuses split tool pairs, exact pins, latest input, and stale observations before writing a bracket', () => {
  const f = fixture()
  const old = f.user('Older input')
  const call = f.assistant(true)
  const tool = f.result()
  const latest = f.user('Latest request')
  const before = f.session.seq
  expect(() => commitNativeRange(f.input([old.seq, call.seq]))).toThrow('dependency')
  expect(() =>
    commitNativeRange({ ...f.input([old.seq, call.seq, tool.seq]), pinned: new Set([old.seq]) }),
  ).toThrow('protected')
  expect(() => commitNativeRange(f.input([latest.seq]))).toThrow('protected')
  expect(f.session.seq).toBe(before)
  const stale = f.input([old.seq, call.seq, tool.seq])
  f.user('An input accepted during asynchronous preparation')
  expect(() => commitNativeRange(stale)).toThrow('changed')
})

it('rejects overlapping transactions, wrong lifecycle ownership, nonshrinking memory, and cancelled commits', () => {
  const f = fixture()
  const old = f.user('Old')
  const answer = f.assistant()
  f.user('New')
  const input = f.input([old.seq, answer.seq])
  expect(() => commitNativeRange({ ...input, mode: 'automatic' })).toThrow('lifecycle')
  expect(() => commitNativeRange({ ...input, memory: 'huge'.repeat(2000) })).toThrow('shrink')
  const abort = new AbortController()
  abort.abort(new Error('cancelled'))
  expect(() => commitNativeRange({ ...input, signal: abort.signal })).toThrow('cancelled')
  f.events.push(
    f.session.append('compaction/start', { compactionId: CompactionId('other'), turn: null }),
  )
  expect(() => commitNativeRange(f.input([old.seq, answer.seq]))).toThrow('already active')
})

it('treats empty native surfaces as a valid no-op and refuses orphan tool results', () => {
  const f = fixture()
  expect(nativeSurfaceUnits(f.session, f.surface())).toEqual([])
  f.result()
  expect(() => nativeSurfaceUnits(f.session, f.surface())).toThrow('no retained call')
})

it('passes DSH session and compaction invariants for a real live automatic transaction', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(CompactionInvariant)
  const events: SessionEvent[] = []
  ctx.on('session/event', (_session, event) => {
    events.push(event)
  })
  const session = await ctx.sessions.create(SessionId('invariant-native-compaction'))
  try {
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const old = session.append(
      'user/message',
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'An original prompt '.repeat(100) }],
      }),
      { surfaceOp: 'append' },
    )
    const answer = session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        stream: [],
        message: createAssistantMessage({
          source: { provider: 'fixture', model: 'model' },
          content: [{ type: 'text', text: 'An older answer '.repeat(100) }],
        }),
      },
      { surfaceOp: 'append' },
    )
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append(
      'user/message',
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Latest exact request.' }],
      }),
      { surfaceOp: 'append' },
    )
    const log: SessionLogSnapshot = {
      session: session.header,
      inheritedEventCount: session.inheritedEventCount,
      events: [...events],
    }
    const surface: SessionSurfaceSnapshot = {
      session: session.header,
      inheritedEventCount: session.inheritedEventCount,
      capturedThroughSeq: events.at(-1)!.seq,
      events: events.filter(isSurfaceEvent),
    }
    const result = commitNativeRange({
      session,
      log,
      surface,
      mode: 'automatic',
      shadowedSeqs: [old.seq, answer.seq],
      shadowedTokenCount: 700,
      memory: 'Attributed evidence remains retrievable.',
      signal: new AbortController().signal,
    })
    expect(
      events
        .filter((event) => event.type === 'compaction/start' || event.type === 'compaction/end')
        .map((event) => event.data),
    ).toEqual([
      { compactionId: result.compactionId, turn: 2 },
      { compactionId: result.compactionId, turn: 2 },
    ])
    expect(events.at(-3)?.type).toBe('compaction/summary')
    expect(events.at(-2)?.type).toBe('user/message')
    expect(session.deriveMessages().at(-1)?.content).toEqual([
      { type: 'text', text: 'Latest exact request.' },
    ])
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  } finally {
    await ctx.fiber.dispose()
  }
})

it('masks a bulky closed tool observation while preserving the latest user and call/result identity', () => {
  const f = fixture()
  const human = f.user('Keep my latest instruction exactly.')
  const call = f.assistant(true)
  const original = `${'Beginning: failed output; no approval. 🪼 '.repeat(1000)}Final qualifier: do not deploy.`
  const tool = f.result(original)
  const sources = new Map([
    [tool.seq, { eventId: `dsh:${tool.seq}`, seq: 1, evidenceIds: [1, 2, 3] }],
  ])
  const surface = f.surface(),
    masks = observationMasks(f.session, surface, sources)
  expect(masks).toHaveLength(1)
  expect(masks[0]?.message).toMatchObject({
    id: masks[0]?.original.id,
    toolCallId: ToolCallId('call'),
    isError: false,
  })
  const text = masks[0]!.message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  expect(text).toContain('Beginning: failed output')
  expect(text).toContain('Final qualifier: do not deploy.')
  expect(text).toContain('evidence_read')
  expect(text).not.toContain('�')
  commitObservationMasks(
    f.session,
    surface,
    masks,
    (message) => JSON.stringify(message.content).length,
    new AbortController().signal,
  )
  expect(f.session.surface.nodes).toContain(human.seq)
  expect(f.session.surface.nodes).toContain(call.seq)
  expect(f.session.surface.nodes).not.toContain(tool.seq)
  expect(f.session.deriveMessages().find((message) => message.role === 'user')?.content).toEqual([
    { type: 'text', text: 'Keep my latest instruction exactly.' },
  ])
  expect(f.session.deriveMessages().find((message) => message.role === 'tool')?.content).toEqual(
    masks[0]?.message.content,
  )
})
