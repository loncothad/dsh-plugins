import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { requestRecipe } from '../src/replay.ts'
import { SqliteEvidenceStore } from '../src/store.ts'

it('keeps acknowledged original evidence readable after archive process death at file-sync and rename', async () => {
  for (const phase of ['file-sync', 'rename']) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evidence-crash-'))
    const path = join(dir, 'evidence.sqlite'),
      scope = { workspaceId: 'workspace', sessionId: 'session' }
    let store = new SqliteEvidenceStore(path, 'workspace')
    try {
      const text = 'Original acknowledged observation with qualifiers. '.repeat(1000)
      const captured = store.capture(scope, {
        id: 'original',
        role: 'tool',
        group: 'closed',
        closed: true,
        text,
      })
      for (let generation = 0; generation < 3; generation++) {
        const request = { generation },
          hash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
        store.stateStore.manifest(scope, {
          request: requestRecipe(request, []),
          state: store.stateStore.state(scope),
          selected: [],
          atomIds: [],
          requestHash: hash,
          inputTokens: 10,
          rendererVersion: 'fixture',
          adapterVersion: 'fixture',
        })
      }
      const candidate = store.coldCandidates(Date.now() + 86400001, 1)[0]!
      const worker = new Worker(new URL('./crash-archive.mjs', import.meta.url), {
        workerData: { phase },
      })
      const exited = once(worker, 'exit')
      worker.postMessage({ id: 1, candidate, directory: join(dir, 'objects'), preferred: 'gzip' })
      expect((await exited)[0]).toBe(91)
      store.close()
      store = new SqliteEvidenceStore(path, 'workspace')
      const hits = captured.evidenceIds.flatMap((_id, index) =>
        index % 8 === 0 ? store.read(scope, captured.evidenceIds.slice(index, index + 8)) : [],
      )
      expect(hits.map((hit) => hit.quote).join('')).toBe(text)
      store.cleanupOrphans(Date.now() + 86400001, 32)
      expect(store.read(scope, captured.evidenceIds.slice(0, 8))).toHaveLength(8)
    } finally {
      store.close()
      await rm(dir, { recursive: true, force: true })
    }
  }
})

it('retries unacknowledged capture idempotently after death before and after the SQLite commit', async () => {
  for (const phase of ['before-commit', 'after-commit']) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-capture-crash-')),
      path = join(dir, 'evidence.sqlite')
    const event = {
      id: 'interrupted',
      role: 'user',
      group: 'closed',
      closed: true,
      text: 'The source says unless explicitly approved. İstanbul 🌍.',
    }
    const worker = new Worker(new URL('./crash-capture.mjs', import.meta.url), {
      workerData: { path, phase, event },
    })
    expect((await once(worker, 'exit'))[0]).toBe(phase === 'before-commit' ? 92 : 93)
    const store = new SqliteEvidenceStore(path, 'workspace'),
      scope = { workspaceId: 'workspace', sessionId: 'session' }
    try {
      expect(store.status().events).toBe(phase === 'before-commit' ? 0 : 1)
      const captured = store.capture(scope, event)
      expect(store.capture(scope, event).evidenceIds).toEqual(captured.evidenceIds)
      expect(store.status().events).toBe(1)
      expect(store.read(scope, captured.evidenceIds)[0]?.quote).toBe(event.text)
      expect(store.search(scope, 'approved')).toHaveLength(1)
    } finally {
      store.close()
      await rm(dir, { recursive: true, force: true })
    }
  }
})

it('retains exact originals through process death before and after compressed-pointer publication', async () => {
  for (const phase of ['before-commit', 'after-commit']) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pointer-crash-')),
      path = join(dir, 'evidence.sqlite'),
      scope = { workspaceId: 'workspace', sessionId: 'session' }
    let store = new SqliteEvidenceStore(path, 'workspace')
    try {
      const text = 'Repeated output is evidence, not permission. '.repeat(500)
      const captured = store.capture(scope, {
        id: 'original',
        role: 'tool',
        group: 'closed',
        closed: true,
        text,
      })
      for (let i = 0; i < 3; i++)
        store.stateStore.manifest(scope, {
          request: requestRecipe(i, []),
          state: store.stateStore.state(scope),
          selected: [],
          atomIds: [],
          requestHash: createHash('sha256').update(JSON.stringify(i)).digest('hex'),
          inputTokens: 1,
          rendererVersion: 'fixture',
          adapterVersion: 'fixture',
        })
      const candidate = store.coldCandidates(Date.now() + 25 * 3600000, 1)[0]
      store.close()
      const worker = new Worker(new URL('./crash-capture.mjs', import.meta.url), {
        workerData: { path, phase, candidate },
      })
      expect((await once(worker, 'exit'))[0]).toBe(phase === 'before-commit' ? 92 : 93)
      store = new SqliteEvidenceStore(path, 'workspace')
      expect(
        store
          .read(scope, captured.evidenceIds)
          .map((hit) => hit.quote)
          .join(''),
      ).toBe(text)
      if (phase === 'before-commit')
        expect(store.status().storedBytes).toBe(store.status().rawBytes)
      else expect(store.status().storedBytes).toBeLessThan(store.status().rawBytes)
    } finally {
      store.close()
      await rm(dir, { recursive: true, force: true })
    }
  }
})
