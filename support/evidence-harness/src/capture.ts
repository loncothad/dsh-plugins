/** Capture authored log components, never generated checkpoints or pruned surface copies. */
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type {} from '@deepseek-ai/dsh-compaction'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveEventMessage, isAppendSurfaceEvent, isSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import type {
  CapturedEvent,
  CaptureResult,
  EvidenceStore,
  Scope,
} from '@loncothad/dsh-evidence-store'

export interface WorkspaceBinding {
  cwd: string
  workspaceId: string
}

/** Canonical filesystem identity is host-owned; aliases of one workspace share one archive. */
export async function bindWorkspace(cwd: string): Promise<WorkspaceBinding> {
  if (!isAbsolute(cwd)) throw new Error('Evidence capture requires an absolute workspace directory')
  const canonical = await realpath(cwd)
  if (!(await stat(canonical)).isDirectory())
    throw new Error('Evidence workspace must be a directory')
  return { cwd: canonical, workspaceId: createHash('sha256').update(canonical).digest('hex') }
}

export interface OriginalComponent {
  seq: number
  event: CapturedEvent
}

/** Original text stays readable and verbatim; other blocks retain their exact JSON representation. */
export function originalComponent(
  event: SessionEvent,
  group: string,
  closed: boolean,
): OriginalComponent | undefined {
  // SDK system/developer rewrites contain newly authored instructions, not generated historical summaries.
  if (
    !isAppendSurfaceEvent(event) &&
    !(
      isSurfaceEvent(event) &&
      (event.type === 'system/message' || event.type === 'developer/message')
    )
  )
    return
  const message = deriveEventMessage(event)
  if (!message || message.source.kind === 'compact-checkpoint') return
  // A user-role injected file/skill/tool notice is evidence, not a human's authorization.
  const role = message.role === 'user' && message.source.kind !== 'user' ? 'context' : message.role
  let position = 0
  const layout: { type: string; encoding: 'text' | 'json'; startByte: number; endByte: number }[] =
    []
  const text = message.content
    .map((block, index) => {
      if (index) position++
      const encoding = block.type === 'text' || block.type === 'reasoning' ? 'text' : 'json'
      const value =
        block.type === 'text' || block.type === 'reasoning' ? block.text : JSON.stringify(block)
      const startByte = position
      position += Buffer.byteLength(value, 'utf8')
      layout.push({ type: block.type, encoding, startByte, endByte: position })
      return value
    })
    .join('\n')
  // Do not duplicate snapshot text or persist opaque provider replay envelopes in attribution.
  const source: Record<string, string> = { kind: message.source.kind }
  for (const key of ['form', 'provider', 'model', 'callId']) {
    const value: unknown = Reflect.get(message.source, key)
    if (typeof value === 'string') source[key] = value
  }
  return {
    seq: event.seq,
    event: {
      id: `dsh:${event.seq}`,
      group,
      closed,
      role,
      text,
      metadata: {
        nativeSeq: event.seq,
        messageId: message.id,
        nativeRole: message.role,
        source,
        eventType: event.type,
        blocks: layout,
        ...(message.role === 'tool'
          ? { toolCallId: message.toolCallId, isError: message.isError }
          : {}),
      },
    },
  }
}

/** Replay a single detached public session-query observation before any originals are evicted. */
export async function captureOriginalLog(
  store: Pick<EvidenceStore, 'capture' | 'seal'> & Partial<Pick<EvidenceStore, 'deleted'>>,
  binding: WorkspaceBinding,
  snapshot: SessionLogSnapshot,
  afterSeq = -1,
): Promise<{ scope: Scope; sources: Map<number, CaptureResult> }> {
  if (
    !snapshot.session.cwd ||
    (await bindWorkspace(snapshot.session.cwd)).workspaceId !== binding.workspaceId
  )
    throw new Error('Session does not belong to this evidence workspace')
  const scope: Scope = { workspaceId: binding.workspaceId, sessionId: snapshot.session.id }
  const sources = new Map<number, CaptureResult>()
  const deleted = new Set<string>()
  if (store.deleted)
    for (let start = 0; start < snapshot.events.length; start += 1024) {
      for (const id of await store.deleted(
        scope,
        snapshot.events.slice(start, start + 1024).map((event) => `dsh:${event.seq}`),
      ))
        deleted.add(id)
    }
  const closed = new Set<string>()
  const sealNeeded = new Set<string>()
  for (let index = 0; index < snapshot.events.length; index++) {
    const event = snapshot.events[index]!
    if (event.seq !== index)
      throw new Error('Evidence recovery requires a complete contiguous session observation')
    if (event.type === 'turn/end') closed.add(`turn:${event.data.turn}`)
    if (event.type === 'turn/start') closed.add('prefix')
    if (event.seq > afterSeq && event.type === 'turn/end') sealNeeded.add(`turn:${event.data.turn}`)
    if (event.seq > afterSeq && event.type === 'turn/start') sealNeeded.add('prefix')
  }
  let group = 'prefix'
  for (const event of snapshot.events) {
    if (event.type === 'turn/start') group = `turn:${event.data.turn}`
    if (event.seq <= afterSeq) continue
    // Group ownership carried by native message events wins over the current traversal turn.
    const owned =
      event.data &&
      typeof event.data === 'object' &&
      'turn' in event.data &&
      typeof event.data.turn === 'number'
        ? `turn:${event.data.turn}`
        : group
    const component = originalComponent(event, owned, closed.has(owned))
    if (component && !deleted.has(component.event.id))
      sources.set(component.seq, await store.capture(scope, component.event))
  }
  // An occurrence captured while its turn was open can now be sealed without rewriting its payload.
  for (const owner of sealNeeded) await store.seal(scope, owner)
  return { scope, sources }
}
