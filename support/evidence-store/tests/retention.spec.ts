import { expect, it } from 'vitest'
import { SqliteEvidenceStore } from '../src/store.ts'

const scope = (sessionId: string) => ({ workspaceId: 'workspace', sessionId })
it('retires bounded inactive evidence while preserving shared objects and open sessions', () => {
  const store = new SqliteEvidenceStore(':memory:', 'workspace')
  try {
    const event = {
      id: 'one',
      group: 'closed',
      role: 'user',
      text: 'Shared original bytes',
      closed: true,
    }
    const old = store.capture(scope('old'), event),
      live = store.capture(scope('live'), event)
    const open = store.capture(scope('open'), { ...event, closed: false })
    expect(store.retire(Date.now() + 1000, ['live'], 1)).toBe(1)
    expect(store.read(scope('old'), old.evidenceIds)).toEqual([])
    expect(store.read(scope('live'), live.evidenceIds)[0]?.quote).toBe(event.text)
    expect(store.read(scope('open'), open.evidenceIds)[0]?.quote).toBe(event.text)
    expect(store.deleted(scope('old'), ['one'])).toEqual(['one'])
    expect(() => store.capture(scope('old'), event)).toThrow('deleted')
  } finally {
    store.close()
  }
})
it('reclaims unreferenced bytes without preventing a new independent occurrence', () => {
  const store = new SqliteEvidenceStore(':memory:', 'workspace')
  try {
    const event = { id: 'one', group: 'closed', role: 'user', text: 'Original data', closed: true }
    store.capture(scope('old'), event)
    store.retire(Date.now() + 1000, [], 1)
    expect(store.status().storedBytes).toBe(0)
    const fresh = store.capture(scope('new'), event)
    expect(store.read(scope('new'), fresh.evidenceIds)[0]?.quote).toBe(event.text)
    expect(store.deleted(scope('old'), ['one'])).toEqual(['one'])
  } finally {
    store.close()
  }
})
