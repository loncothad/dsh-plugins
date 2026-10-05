import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { collectNativeText } from '../src/native-text.ts'

async function* stream(chunks: StreamChunk[]) {
  yield* chunks
}
const signal = () => new AbortController().signal
it('accepts the native delta-only Codex protocol without displaying reasoning or counting text twice', async () => {
  const chunks: StreamChunk[] = [
    { type: 'reasoning-delta', index: 1, text: 'Private analysis' },
    { type: 'text-delta', index: 0, text: 'Verified ' },
    { type: 'text-delta', index: 0, text: 'observation' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  expect(await collectNativeText(stream(chunks), signal(), 100)).toBe('Verified observation')
})
it('rejects tools, truncated output and an explicitly opened block without closure', async () => {
  await expect(
    collectNativeText(
      stream([
        {
          type: 'tool-call-delta',
          index: 0,
          id: 'tool' as never,
          name: 'publish',
          argumentsDelta: '{}',
        },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
      signal(),
      100,
    ),
  ).rejects.toThrow('cannot call tools')
  await expect(
    collectNativeText(
      stream([
        { type: 'text-delta', index: 0, text: 'Unfinished' },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ]),
      signal(),
      100,
    ),
  ).rejects.toThrow('did not finish')
  await expect(
    collectNativeText(
      stream([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'Unclosed' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
      signal(),
      100,
    ),
  ).rejects.toThrow('did not finish')
})
