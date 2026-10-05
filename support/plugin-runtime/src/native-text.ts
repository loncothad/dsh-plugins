import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { abortable } from './cancellation.ts'

async function* cancellable(
  stream: AsyncIterable<StreamChunk>,
  signal: AbortSignal,
): AsyncIterable<StreamChunk> {
  const iterator = stream[Symbol.asyncIterator]()
  try {
    while (true) {
      const item = await abortable(Promise.resolve(iterator.next()), signal)
      if (item.done) return
      yield item.value
    }
  } finally {
    if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {})
  }
}
/** Accept complete native text only. Reasoning is bounded but never displayed; tools and truncation fail. */
export async function collectNativeText(
  stream: AsyncIterable<StreamChunk>,
  signal: AbortSignal,
  maxCharacters: number,
): Promise<string> {
  const blocks = new Map<
    number,
    { type: string; text: string; ended: boolean; delta: boolean; implicit: boolean }
  >()
  let chunks = 0,
    size = 0,
    finished = false
  for await (const chunk of cancellable(stream, signal)) {
    signal.throwIfAborted()
    if (++chunks > 16384 || finished) throw new Error('Invalid auxiliary stream')
    if (chunk.type === 'usage') continue
    if (chunk.type === 'finish') {
      if (
        chunk.reason.kind !== 'stop' ||
        [...blocks.values()].some((block) => !block.ended && !block.implicit)
      )
        throw new Error('Auxiliary model did not finish successfully')
      for (const block of blocks.values()) if (block.implicit) block.ended = true
      finished = true
      continue
    }
    if (chunk.type === 'block-start') {
      if (
        blocks.has(chunk.index) ||
        blocks.size >= 32 ||
        !['text', 'reasoning'].includes(chunk.blockType)
      )
        throw new Error('Auxiliary models cannot call tools')
      blocks.set(chunk.index, {
        type: chunk.blockType,
        text: '',
        ended: false,
        delta: false,
        implicit: false,
      })
      continue
    }
    if (chunk.type === 'tool-call-delta') throw new Error('Auxiliary models cannot call tools')
    let block = blocks.get(chunk.index)
    if (!block && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')) {
      if (blocks.size >= 32) throw new Error('Auxiliary block capacity exceeded')
      block = {
        type: chunk.type === 'text-delta' ? 'text' : 'reasoning',
        text: '',
        ended: false,
        delta: false,
        implicit: true,
      }
      blocks.set(chunk.index, block)
    }
    if (!block || block.ended) throw new Error('Invalid auxiliary block order')
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      if (block.type !== (chunk.type === 'text-delta' ? 'text' : 'reasoning'))
        throw new Error('Invalid auxiliary block type')
      block.text += chunk.text
      block.delta = true
      size += chunk.text.length
    } else if (chunk.type === 'block-end') {
      if (
        (chunk.block.type !== 'text' && chunk.block.type !== 'reasoning') ||
        chunk.block.type !== block.type ||
        (block.delta && chunk.block.text !== block.text)
      )
        throw new Error('Invalid auxiliary block closure')
      if (!block.delta) {
        block.text = chunk.block.text
        size += block.text.length
      }
      block.ended = true
    }
    if (size > Math.max(maxCharacters, 65536))
      throw new Error('Auxiliary model output exceeds its limit')
  }
  const text = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, block]) => block.type === 'text')
    .map(([, block]) => block.text)
    .join('\n')
    .trim()
  if (!finished || !text || text.length > maxCharacters)
    throw new Error('Auxiliary model output is missing, incomplete or oversized')
  return text
}
