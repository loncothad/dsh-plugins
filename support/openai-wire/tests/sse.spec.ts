import { expect, it } from 'vitest'
import { SseDecoder } from '../src/sse.ts'

it('preserves split UTF-8 characters and CRLF event boundaries', () => {
  const bytes = new TextEncoder().encode('data: İstanbul 🌍\r\n\r\ndata: next\r\n\r\n')
  const decoder = new SseDecoder()
  const events: string[] = []
  for (const byte of bytes) events.push(...decoder.push(Uint8Array.of(byte)))
  events.push(...decoder.flush())
  expect(events).toEqual(['İstanbul 🌍', 'next'])
})

it('rejects oversized unsealed events and incomplete UTF-8', () => {
  expect(() => new SseDecoder().push(`data: ${'x'.repeat(4 * 1024 * 1024)}`)).toThrow('exceeds')
  const decoder = new SseDecoder()
  decoder.push(Uint8Array.of(0xf0))
  expect(() => decoder.flush()).toThrow()
})
