import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { parseEvidenceView } from '../src/control-wire.ts'
import { envelopeTokens, requestHash } from '../src/measurement.ts'

it('records semantic native request identity independently of cancellation and checkpoint correlation IDs', () => {
  const request = (id: string) => ({
    provider: 'fixture',
    model: 'model',
    messages: [
      createUserMessage({
        source: compactCheckpointSource(CompactionId(id)),
        content: [{ type: 'text' as const, text: 'Exact readable memory' }],
      }),
    ],
    tools: [{ name: 'read', description: 'Read only', parameters: { type: 'object' } }],
  })
  expect(requestHash(request('first'))).toBe(
    requestHash({ ...request('second'), signal: new AbortController().signal }),
  )
  expect(requestHash(request('first'))).not.toBe(
    requestHash({ ...request('first'), maxTokens: 1500 }),
  )
  expect(requestHash(request('first'))).not.toBe(requestHash({ ...request('first'), tools: [] }))
  expect(envelopeTokens(request('first'))).toBeGreaterThan(
    envelopeTokens({ ...request('first'), tools: [] }),
  )
})

it('validates the safe native control view and strips unregistered host fields', () => {
  const value = {
    installed: ['preset-standard'],
    installing: false,
    extractionEnabled: false,
    workspaces: 1,
    sessions: 2,
    error: '',
  }
  expect(parseEvidenceView({ ...value, secret: 'private' })).toEqual(value)
  expect(() => parseEvidenceView({ ...value, sessions: -1 })).toThrow('Invalid')
  expect(() => parseEvidenceView({ ...value, installed: ['x'.repeat(257)] })).toThrow('Invalid')
})
