/** Native source layouts let replay reference original bytes without copying large tool text. */
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionSurfaceSnapshot } from '@deepseek-ai/dsh-session-query'
import type { CaptureResult, ReplaySource } from '@loncothad/dsh-evidence-store'

export function nativeReplaySources(
  session: Session,
  surface: SessionSurfaceSnapshot,
  sources: ReadonlyMap<number, CaptureResult>,
  retained: ReadonlySet<number>,
): ReplaySource[] {
  const result: ReplaySource[] = []
  for (const event of surface.events) {
    if (!retained.has(event.seq)) continue
    const captured = sources.get(event.seq),
      message = session.deriveEventMessage(event)
    if (!captured?.evidenceIds.length || !message || message.source.kind === 'compact-checkpoint')
      continue
    let position = 0
    for (const [index, block] of message.content.entries()) {
      if (index) position++
      const encoding = block.type === 'text' || block.type === 'reasoning' ? 'text' : 'json'
      const text =
        encoding === 'text' && (block.type === 'text' || block.type === 'reasoning')
          ? block.text
          : JSON.stringify(block)
      const startByte = position
      position += Buffer.byteLength(text, 'utf8')
      if (text)
        result.push({
          value: encoding === 'text' ? text : block,
          ids: captured.evidenceIds,
          startByte,
          endByte: position,
          encoding,
        })
    }
  }
  return result
}
