import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { EvidenceStore } from '../src/index.ts'

it('captures through the shipped storage worker and reads acknowledged evidence after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-evidence-worker-'))
  const path = join(dir, 'evidence.sqlite')
  const worker = new URL('../lib/worker.js', import.meta.url)
  let store = new EvidenceStore(path, 'workspace', worker)
  const scope = { workspaceId: 'workspace', sessionId: 'session' }
  try {
    const captured = await store.capture(scope, {
      id: 'host-event',
      role: 'tool',
      group: 'tool-call-1',
      closed: true,
      text: 'A failed build is not an approval to publish.',
    })
    expect((await store.search(scope, 'approval'))[0]?.eventId).toBe('host-event')
    await Promise.all([store.close(), store.close()])
    store = new EvidenceStore(path, 'workspace', worker)
    expect((await store.read(scope, captured.evidenceIds))[0]?.quote).toContain('not an approval')
    await store.delete(scope, 'host-event')
    expect(await store.search(scope, 'approval')).toEqual([])
  } finally {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('rejects pending calls when a worker cannot open the database', async () => {
  const store = new EvidenceStore(':memory:', '', new URL('../lib/worker.js', import.meta.url))
  await expect(store.status()).rejects.toThrow('workspace identity')
  await store.close()
})
