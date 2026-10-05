import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { encodeFrame } from '../src/codec.ts'
import { EvidenceStore } from '../src/index.ts'
import { requestRecipe } from '../src/replay.ts'
import { SqliteEvidenceStore } from '../src/store.ts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
it('sweeps old abandoned frames and partial temporaries without deleting referenced or recent data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-orphan-cleanup-')),
    objects = join(dir, 'objects')
  const store = new SqliteEvidenceStore(join(dir, 'evidence.sqlite'), 'workspace')
  const scope = { workspaceId: 'workspace', sessionId: 'session' }
  try {
    await mkdir(objects)
    const text = 'Referenced original evidence with exact qualifiers.\n'.repeat(500)
    const captured = store.capture(scope, {
      id: 'original',
      role: 'tool',
      group: 'closed',
      closed: true,
      text,
    })
    const hot = store.capture(scope, {
      id: 'hot',
      role: 'user',
      group: 'closed',
      closed: true,
      text: 'Continue.',
    })
    for (let i = 0; i < 3; i++)
      store.stateStore.manifest(scope, {
        request: requestRecipe(i, []),
        state: store.stateStore.state(scope),
        selected: [{ id: 'hot', mode: 'original', evidenceIds: hot.evidenceIds }],
        atomIds: [],
        requestHash: hash(String(i)),
        inputTokens: 1,
        rendererVersion: '1',
        adapterVersion: 'test',
      })
    const candidate = store.coldCandidates(Date.now() + 25 * 3600000, 1)[0]!,
      encoded = encodeFrame(candidate.bytes, 'gzip')!
    const referenced = `${candidate.id}.gzip.ev`
    await writeFile(join(objects, referenced), encoded.frame)
    expect(store.publishCompressed(candidate, { ...encoded, path: referenced })).toBe(true)
    const abandonedText = 'Abandoned compressed representation.\n'.repeat(500),
      abandoned = `${hash(abandonedText)}.gzip.ev`
    await writeFile(
      join(objects, abandoned),
      encodeFrame(Buffer.from(abandonedText), 'gzip')!.frame,
    )
    const temporary = `${hash('partial')}.${randomUUID()}.tmp`
    await writeFile(join(objects, temporary), 'EV')
    const recent = `${hash('recent')}.${randomUUID()}.tmp`
    await writeFile(join(objects, recent), 'EV')
    await writeFile(join(objects, 'unrelated.txt'), 'Keep this file')
    const invalidFrame = `${hash('unrelated frame-shaped name')}.gzip.ev`
    await writeFile(join(objects, invalidFrame), 'Unrelated file, not an evidence frame')
    const link = `${hash('link')}.${randomUUID()}.tmp`
    await symlink(join(objects, 'unrelated.txt'), join(objects, link))
    const old = new Date(Date.now() - 48 * 3600000)
    for (const name of [referenced, abandoned, temporary, 'unrelated.txt', invalidFrame])
      await utimes(join(objects, name), old, old)
    // Small passes must advance beyond retained entries rather than always starting at the first file.
    let removed = 0
    for (let pass = 0; pass < 10; pass++) {
      const count = store.cleanupOrphans(Date.now(), 2)
      expect(count).toBeLessThanOrEqual(2)
      removed += count
    }
    expect(removed).toBe(2)
    await expect(readFile(join(objects, abandoned))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(objects, temporary))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(objects, recent), 'utf8')).toBe('EV')
    expect(await readFile(join(objects, invalidFrame), 'utf8')).toBe(
      'Unrelated file, not an evidence frame',
    )
    expect(await readFile(join(objects, 'unrelated.txt'), 'utf8')).toBe('Keep this file')
    expect(await readFile(join(objects, link), 'utf8')).toBe('Keep this file')
    const hits = captured.evidenceIds.flatMap((_id, index) =>
      index % 8 === 0 ? store.read(scope, captured.evidenceIds.slice(index, index + 8)) : [],
    )
    expect(hits.map((hit) => hit.quote).join('')).toBe(text)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('runs orphan cleanup through idle maintenance after worker restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-orphan-worker-')),
    objects = join(dir, 'objects'),
    path = join(dir, 'evidence.sqlite')
  const worker = new URL('../lib/worker.js', import.meta.url),
    scope = { workspaceId: 'workspace', sessionId: 'session' }
  let store = new EvidenceStore(path, 'workspace', worker)
  try {
    const captured = await store.capture(scope, {
      id: 'original',
      role: 'user',
      group: 'closed',
      closed: true,
      text: 'Retain these acknowledged original bytes.',
    })
    await store.close()
    await mkdir(objects)
    const pathOfOrphan = join(objects, `${hash('interrupted')}.${randomUUID()}.tmp`)
    await writeFile(pathOfOrphan, 'partial')
    const old = new Date(Date.now() - 48 * 3600000)
    await utimes(pathOfOrphan, old, old)
    store = new EvidenceStore(path, 'workspace', worker)
    expect(await store.maintain(new AbortController().signal)).toBe(0)
    await expect(readFile(pathOfOrphan)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await store.read(scope, captured.evidenceIds))[0]?.quote).toBe(
      'Retain these acknowledged original bytes.',
    )
  } finally {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('does not follow an archive-directory symlink during cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-orphan-directory-')),
    foreign = join(dir, 'foreign')
  const store = new SqliteEvidenceStore(join(dir, 'evidence.sqlite'), 'workspace')
  try {
    await mkdir(foreign)
    const name = `${hash('foreign')}.${randomUUID()}.tmp`,
      path = join(foreign, name)
    await writeFile(path, 'Keep foreign bytes')
    const old = new Date(Date.now() - 48 * 3600000)
    await utimes(path, old, old)
    await symlink(foreign, join(dir, 'objects'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(store.cleanupOrphans(Date.now())).toBe(0)
    expect(await readFile(path, 'utf8')).toBe('Keep foreign bytes')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
