import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { SqliteEvidenceStore } from '../src/store.ts'

const a = { workspaceId: 'workspace', sessionId: 'a' }
const b = { workspaceId: 'workspace', sessionId: 'b' }
const event = (id: string, text = 'Never publish without explicit approval.') => ({
  id,
  text,
  role: 'user',
  group: 'exchange-1',
  closed: true,
})

it('preserves repeated occurrences while deduplicating their original bytes across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-evidence-'))
  const path = join(dir, 'evidence.sqlite')
  let store = new SqliteEvidenceStore(path, 'workspace')
  try {
    const first = store.capture(a, event('host-1'))
    expect(store.capture(a, event('host-1'))).toEqual(first)
    const second = store.capture(a, event('host-2'))
    expect(second.seq).toBe(first.seq + 1)
    expect(second.evidenceIds).not.toEqual(first.evidenceIds)
    expect(store.status()).toMatchObject({
      objects: 1,
      events: 2,
      spans: 2,
      sqliteVersion: '3.53.4',
    })
    store.close()
    store = new SqliteEvidenceStore(path, 'workspace')
    expect(store.read(a, first.evidenceIds)[0]?.quote).toBe(event('host-1').text)
    expect(store.search(a, 'approval').map((hit) => hit.eventId)).toEqual(['host-1', 'host-2'])
    expect(() => store.capture(a, event('host-1', 'changed'))).toThrow('identity')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('applies scope and availability before search limits and never resurrects deleted occurrences', () => {
  const store = new SqliteEvidenceStore(':memory:', 'workspace')
  try {
    const hidden = store.capture(a, event('first'))
    for (let i = 0; i < 20; i++) store.capture(a, event(`other-${i}`))
    const visible = store.capture(b, event('second'))
    expect(store.search(b, 'approval', 1).map((hit) => hit.eventId)).toEqual(['second'])
    expect(store.read(b, hidden.evidenceIds)).toEqual([])
    store.delete(b, 'second')
    expect(store.search(b, 'approval')).toEqual([])
    expect(store.read(b, visible.evidenceIds)).toEqual([])
    expect(() => store.capture(b, event('second'))).toThrow('deleted')
    expect(store.search(a, 'approval', 1)).toHaveLength(1)
    expect(() => store.search({ ...b, workspaceId: 'foreign' }, 'approval')).toThrow('scope')
  } finally {
    store.close()
  }
})

it('splits multi-byte original text into independently bounded, exact UTF-8 spans', () => {
  const store = new SqliteEvidenceStore(':memory:', 'workspace')
  try {
    const text = '🌍İstanbul'.repeat(40_000)
    const captured = store.capture(a, event('large', text))
    const hits = captured.evidenceIds.flatMap((_id, i) =>
      i % 8 === 0 ? store.read(a, captured.evidenceIds.slice(i, i + 8)) : [],
    )
    expect(hits.map((hit) => hit.quote).join('')).toBe(text)
    expect(hits.every((hit) => hit.endByte <= 256 * 1024)).toBe(true)
    expect(() => store.read(a, Array(9).fill(1))).toThrow('page')
    const bom = store.capture(a, event('bom', '\uFEFFOriginal text with a byte order mark.'))
    expect(store.read(a, bom.evidenceIds)[0]?.quote).toBe(
      '\uFEFFOriginal text with a byte order mark.',
    )
    expect(() => store.capture(a, event('invalid', '\uD800'))).toThrow('Unicode')
  } finally {
    store.close()
  }
})

it('detects corrupt original bytes and refuses a database from another workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-evidence-corrupt-'))
  const path = join(dir, 'evidence.sqlite')
  const store = new SqliteEvidenceStore(path, 'workspace')
  try {
    const captured = store.capture(a, event('original'))
    const tamper = new Database(path)
    try {
      tamper.prepare('UPDATE objects SET bytes=?').run(Buffer.from('corrupt'))
    } finally {
      tamper.close()
    }
    expect(() => store.read(a, captured.evidenceIds)).toThrow('corrupt')
    expect(() => new SqliteEvidenceStore(path, 'foreign')).toThrow('another workspace')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
