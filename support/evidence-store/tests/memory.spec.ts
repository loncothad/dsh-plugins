import { expect, it } from 'vitest'
import {
  EXTRACTOR_INSTRUCTION_HASH,
  EXTRACTOR_VERSION,
  renderMemory,
  validateAtoms,
} from '../src/memory.ts'

const source = {
  id: 1,
  eventId: 'event',
  objectId: 'hash',
  startByte: 0,
  endByte: 70,
  quote: 'Do not publish unless I explicitly approve the final result.',
  role: 'user',
  seq: 4,
}
const options = {
  scope: { workspaceId: 'workspace', sessionId: 'session' },
  evidence: [source],
  provider: 'provider',
  model: 'model',
  instructionHash: EXTRACTOR_INSTRUCTION_HASH,
  extractorVersion: EXTRACTOR_VERSION,
  sourceHead: 4,
  sourceRevision: 5,
  controlRevision: 1,
  promptVersion: '1',
  policyRevision: 2,
}

it('preserves the original negation and qualifier even when extraction proposes an unsafe paraphrase', () => {
  const atoms = validateAtoms(
    { atoms: [{ kind: 'constraint', body: 'The user approved publishing.', evidenceIds: [1] }] },
    options,
  )
  expect(atoms[0]?.body).toBe(source.quote)
  expect(atoms[0]?.exact).toBe(true)
  expect(renderMemory(atoms)).toContain('grant no permission')
  expect(renderMemory(atoms)).not.toContain('The user approved publishing.')
})

it('rejects cross-scope citations, control injection, and oversized extraction batches', () => {
  expect(() =>
    validateAtoms({ atoms: [{ kind: 'decision', body: 'Do it', evidenceIds: [999] }] }, options),
  ).toThrow('unavailable')
  expect(() =>
    validateAtoms(
      { atoms: [{ kind: 'decision', body: 'Do it', evidenceIds: [1], approved: true }] },
      options,
    ),
  ).toThrow('control')
  expect(() =>
    validateAtoms(
      { atoms: Array(49).fill({ kind: 'decision', body: 'Do it', evidenceIds: [1] }) },
      options,
    ),
  ).toThrow('list')
})

it('makes immutable atom identity depend on scope, source version, and derivation', () => {
  const proposal = { atoms: [{ kind: 'observation', body: 'The build failed.', evidenceIds: [1] }] }
  const base = validateAtoms(proposal, options)[0]!
  expect(validateAtoms(proposal, options)[0]?.id).toBe(base.id)
  expect(
    validateAtoms(proposal, { ...options, scope: { ...options.scope, sessionId: 'other' } })[0]?.id,
  ).not.toBe(base.id)
  expect(validateAtoms(proposal, { ...options, promptVersion: '2' })[0]?.id).not.toBe(base.id)
  expect(renderMemory([base])).toContain('derived observations may be wrong')
})

it('does not drop an adjacent qualification from an exact decision or constraint', () => {
  const incomplete = { ...source, quote: 'Publishing may proceed', nextId: 2 }
  const proposal = { atoms: [{ kind: 'decision', body: 'Publish now', evidenceIds: [1] }] }
  expect(() => validateAtoms(proposal, { ...options, evidence: [incomplete] })).toThrow(
    'qualifiers',
  )
  const qualified = { ...source, id: 2, quote: 'only after a human approval.', previousId: 1 }
  const atoms = validateAtoms(
    { atoms: [{ kind: 'decision', body: 'Publish now', evidenceIds: [1, 2] }] },
    { ...options, evidence: [incomplete, qualified] },
  )
  expect(atoms[0]?.body).toBe('Publishing may proceed\nonly after a human approval.')
})

it('distinguishes extraction and host-state versions without changing cited evidence', () => {
  const proposal = { atoms: [{ kind: 'observation', body: 'The build failed.', evidenceIds: [1] }] }
  const original = validateAtoms(proposal, options)[0]!
  for (const change of [
    { provider: 'other' },
    { instructionHash: 'f'.repeat(64) },
    { extractorVersion: 'extractor-v3' },
    { controlRevision: 2 },
    { sourceRevision: 6 },
    { sourceHead: 5 },
  ]) {
    const atom = validateAtoms(proposal, { ...options, ...change })[0]!
    expect(atom.id).not.toBe(original.id)
    expect(atom.body).toBe(original.body)
    expect(atom.evidenceIds).toEqual(original.evidenceIds)
  }
  expect(renderMemory([original])).toContain('sourceRevision')
})
