import type { Message } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { messageImportance } from '../src/importance.ts'

const user = (text: string) =>
  createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const read = (text: string, error = false) =>
  [
    {
      role: 'assistant',
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      content: [{ type: 'tool-call', id: 'call', name: 'read_file', arguments: '{}' }],
    },
    {
      role: 'tool',
      source: { kind: 'tool' },
      toolCallId: 'call',
      isError: error,
      content: [{ type: 'text', text }],
    },
  ] as unknown as Message[]
it('prioritizes corrections, constraints, failures and mutations without making them permissions', () => {
  const seen = new Set<string>()
  expect(messageImportance([user('Correction: do not publish.')], seen).score).toBe(95)
  expect(messageImportance(read('failed', true), seen).reasons).toContain('failed-tool')
  const mutation = [
    { role: 'assistant', content: [{ type: 'tool-call', name: 'apply_patch' }] },
  ] as unknown as Message[]
  expect(messageImportance(mutation, seen).reasons).toContain('file-mutation')
  expect(messageImportance(read('file body'), seen).score).toBe(25)
  expect(messageImportance(read('file body'), seen).score).toBe(10)
  expect(
    messageImportance([user('Never remove this qualifier.'), ...read('file body')], seen).score,
  ).toBe(95)
})
