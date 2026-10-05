/** Native, protocol-balanced surface components and synchronous checkpoint publication. */
import { randomUUID } from 'node:crypto'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot, SessionSurfaceSnapshot } from '@deepseek-ai/dsh-session-query'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import type { AssemblyUnit } from '@loncothad/dsh-evidence-store'
import { messageImportance } from './importance.ts'

export interface NativeContent {
  seqs: SessionSeq[]
  messages: Message[]
}
export type NativeUnit = AssemblyUnit<NativeContent>

function assertSurface(session: Session, snapshot: SessionSurfaceSnapshot): void {
  if (
    snapshot.session.id !== session.id ||
    snapshot.capturedThroughSeq !== (session.seq ? session.seq - 1 : null) ||
    snapshot.events.length !== session.surface.nodes.length ||
    snapshot.events.some((event, index) => event.seq !== session.surface.nodes[index])
  )
    throw new Error('Native evidence surface changed during preparation')
}

/** Closed units include every assistant call/result dependency; open units and instructions are mandatory. */
export function nativeSurfaceUnits(
  session: Session,
  snapshot: SessionSurfaceSnapshot,
  pinned: ReadonlySet<number> = new Set(),
): NativeUnit[] {
  assertSurface(session, snapshot)
  if (pinned.size > 128) throw new Error('Too many exact event pins')
  const visible = snapshot.events.map((event) => ({
    seq: event.seq,
    type: event.type,
    message: session.deriveEventMessage(event),
  }))
  const visibleSeqs = new Set(visible.map((row) => Number(row.seq)))
  const latestUser = visible.findLast(
    (row) => row.message?.role === 'user' && row.message.source.kind === 'user',
  )?.seq
  if ([...pinned].some((seq) => !visibleSeqs.has(seq)))
    throw new Error('An exact pin is absent from the current surface')
  const units: NativeUnit[] = []
  const seenReads = new Set<string>()
  const calls = new Set<string>()
  let content: NativeContent = { seqs: [], messages: [] }
  let instructions = false,
    pin = false,
    latest = false
  const flush = (closed: boolean, memory = false) => {
    if (!content.seqs.length) return
    const kind = instructions
      ? 'instructions'
      : pin
        ? 'pin'
        : latest
          ? 'latest-user'
          : memory
            ? 'memory'
            : 'interaction'
    const retention = messageImportance(content.messages, seenReads)
    units.push({
      id: `native:${content.seqs.join(',')}`,
      kind,
      content,
      closed,
      mandatory: instructions || pin || latest || !closed,
      importance: retention.score,
      importanceReasons: retention.reasons,
    })
    content = { seqs: [], messages: [] }
    instructions = false
    pin = false
    latest = false
  }
  for (const { seq, type, message } of visible) {
    pin ||= pinned.has(seq)
    latest ||= seq === latestUser
    if (!message) {
      // Dormant instruction nodes are still protected against range replacement.
      if (type === 'system/message' || type === 'developer/message') {
        if (!content.seqs.length) {
          content.seqs.push(seq)
          instructions = true
          flush(true)
        } else {
          content.seqs.push(seq)
          instructions = true
        }
      } else content.seqs.push(seq)
      continue
    }
    const isInstruction =
      message.role === 'system' ||
      message.role === 'developer' ||
      ('form' in message.source && message.source.form === 'instructions')
    const standaloneInstruction = isInstruction && !content.seqs.length && !calls.size
    const standaloneMemory =
      message.source.kind === 'compact-checkpoint' && !content.seqs.length && !calls.size
    content.seqs.push(seq)
    content.messages.push(message)
    instructions ||= isInstruction
    if (message.role === 'assistant')
      for (const block of message.content)
        if (block.type === 'tool-call') {
          if (calls.has(block.id))
            throw new Error('Duplicate native tool call in the retained surface')
          calls.add(block.id)
        }
    if (message.role === 'tool' && !calls.delete(message.toolCallId))
      throw new Error('Native tool result has no retained call')
    if (
      standaloneInstruction ||
      standaloneMemory ||
      ((message.role === 'assistant' || message.role === 'tool') && !calls.size)
    )
      flush(true, standaloneMemory)
  }
  flush(false)
  if (units.length > 2048) throw new Error('Native surface exceeds the assembly unit budget')
  return units
}

export interface NativeCommitInput {
  session: Session
  log: SessionLogSnapshot
  surface: SessionSurfaceSnapshot
  /** Exact event pins come from host controls, never from a model argument. */
  pinned?: ReadonlySet<number>
  mode: 'manual' | 'automatic'
  shadowedSeqs: readonly SessionSeq[]
  /** Fixed native heuristic price of the exact replaced nodes, for DSH's shadow-price protocol. */
  shadowedTokenCount: number
  memory: string
  sourceCommandId?: CommandId
  signal: AbortSignal
}

/** Call only after durable capture, manifest publication, and the host source/control/policy recheck. */
export function commitNativeRange(input: NativeCommitInput): CompactionResult {
  const { session, surface, log, shadowedSeqs, shadowedTokenCount, signal } = input
  signal.throwIfAborted()
  assertSurface(session, surface)
  if (
    log.session.id !== session.id ||
    log.events.at(-1)?.seq !== session.seq - 1 ||
    log.events.some((event, index) => event.seq !== index)
  )
    throw new Error('Native compaction log observation is stale or incomplete')
  if (
    !input.memory.trim() ||
    Buffer.byteLength(input.memory, 'utf8') > 64 * 1024 ||
    !Number.isSafeInteger(shadowedTokenCount) ||
    shadowedTokenCount < 1
  )
    throw new Error('Invalid native compaction body or shadow price')
  if (estimateContent([{ type: 'text', text: input.memory }]) + 4 >= shadowedTokenCount)
    throw new Error('Native compaction would not shrink its selected content')
  if (shadowedSeqs.length > 4096)
    throw new Error('Native compaction range exceeds its manifest source budget')
  const selectedSeqs = new Set(shadowedSeqs)
  const seqs = surface.events.map((event) => event.seq)
  const first = seqs.indexOf(shadowedSeqs[0]!),
    last = seqs.indexOf(shadowedSeqs.at(-1)!)
  if (
    first < 0 ||
    last < first ||
    shadowedSeqs.length !== last - first + 1 ||
    shadowedSeqs.some((seq, index) => seq !== seqs[first + index])
  )
    throw new Error('Native compaction range is not a current positional span')
  const currentUnits = nativeSurfaceUnits(session, surface, input.pinned)
  const selected = currentUnits.filter((unit) =>
    unit.content.seqs.some((seq) => selectedSeqs.has(seq)),
  )
  if (
    !selected.length ||
    selected.some(
      (unit) =>
        !unit.closed || unit.mandatory || unit.content.seqs.some((seq) => !selectedSeqs.has(seq)),
    )
  )
    throw new Error('Native compaction would evict protected content or split a dependency group')
  let turn: number | null = null
  let open: string | undefined
  for (const event of log.events) {
    if (event.type === 'session/end-seed') {
      turn = null
      open = undefined
    }
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type === 'turn/end') turn = null
    if (event.type === 'compaction/start') open = event.data.compactionId
    if (event.type === 'compaction/end') open = undefined
  }
  if (open) throw new Error('A native compaction transaction is already active')
  if ((input.mode === 'manual' && turn !== null) || (input.mode === 'automatic' && turn === null))
    throw new Error('Native compaction mode does not match the session turn lifecycle')
  const compactionId = CompactionId(randomUUID())
  const lifecycle = {
    compactionId,
    turn,
    ...(input.sourceCommandId ? { sourceCommandId: input.sourceCommandId } : {}),
  }
  const start = session.append('compaction/start', lifecycle)
  let closing = false
  try {
    const summary: ContentBlock[] = [{ type: 'text', text: input.memory }]
    const range = { start: shadowedSeqs[0]!, end: shadowedSeqs.at(-1)! }
    const summarized = session.append('compaction/summary', {
      compactionId,
      ...(input.sourceCommandId ? { sourceCommandId: input.sourceCommandId } : {}),
      summary,
      shadowedRange: range,
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount,
      provider: 'evidence-store',
      model: 'renderer-v1',
    })
    session.append(
      'user/message',
      createUserMessage({
        source: compactCheckpointSource(compactionId, input.sourceCommandId),
        content: summary,
      }),
      {
        surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.end },
        sourceEventSeqs: [start.seq, summarized.seq, ...shadowedSeqs],
      },
    )
    closing = true
    const end = session.append('compaction/end', lifecycle)
    return {
      compactionId,
      ...(input.sourceCommandId ? { sourceCommandId: input.sourceCommandId } : {}),
      startSeq: start.seq,
      summarySeq: summarized.seq,
      endSeq: end.seq,
      summary,
      shadowedRange: range,
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount,
    }
  } catch (error) {
    // One close attempt. Provider/source text is deliberately excluded from durable diagnostics.
    if (!closing)
      session.append('compaction/end', {
        ...lifecycle,
        error: 'Evidence checkpoint publication failed',
      })
    throw error
  }
}
