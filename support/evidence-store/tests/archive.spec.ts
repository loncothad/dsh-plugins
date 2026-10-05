import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { decodeFrame, encodeFrame } from '../src/codec.ts'
import { EvidenceStore } from '../src/index.ts'
import { requestRecipe } from '../src/replay.ts'
import { SqliteEvidenceStore } from '../src/store.ts'
import type { ManifestInput } from '../src/types.ts'

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const scope = { workspaceId: 'workspace', sessionId: 'session' }
const signal = () => new AbortController().signal

it('round-trips Zstandard and gzip independently and validates original lengths and hashes', () => {
  const original = Buffer.from('🌍 Original observation, not an approval.\n'.repeat(1000))
  for (const codec of ['zstd', 'gzip'] as const) {
    const result = encodeFrame(original, codec)!
    expect(result.frame.length).toBeLessThanOrEqual(original.length * 0.9)
    expect(decodeFrame(result.frame, codec, sha(original), original.length)).toEqual(original)
    expect(() => decodeFrame(result.frame, codec, sha(original), original.length + 1)).toThrow(
      'metadata',
    )
    expect(() => decodeFrame(result.frame, codec, '0'.repeat(64), original.length)).toThrow(
      'metadata',
    )
  }
  expect(encodeFrame(Buffer.from('tiny'))).toBeUndefined()
  expect(encodeFrame(randomBytes(8192))).toBeUndefined()
})

it('does not publish compression after foreground access changes the object revision', () => {
  const store = new SqliteEvidenceStore(':memory:', 'workspace')
  try {
    const archived = store.capture(scope, {
      id: 'old',
      role: 'tool',
      group: 'closed',
      closed: true,
      text: 'observation '.repeat(2000),
    })
    const hot = store.capture(scope, {
      id: 'hot',
      role: 'user',
      group: 'current',
      closed: true,
      text: 'Continue.',
    })
    for (let i = 0; i < 3; i++)
      store.stateStore.manifest(scope, {
        request: requestRecipe(i, []),
        state: store.stateStore.state(scope),
        selected: [{ id: 'hot', mode: 'original', evidenceIds: hot.evidenceIds }],
        atomIds: [],
        requestHash: sha(String(i)),
        inputTokens: 10,
        rendererVersion: '1',
        adapterVersion: 'fixture',
      })
    expect(store.coldCandidates(Date.now(), 1)).toEqual([])
    const now = Date.now() + 25 * 3600_000
    const candidate = store.coldCandidates(now, 1)[0]!
    const encoded = encodeFrame(candidate.bytes)!
    store.read(scope, archived.evidenceIds)
    expect(store.publishCompressed(candidate, encoded)).toBe(false)
    const fresh = store.coldCandidates(now, 1)[0]!
    expect(store.publishCompressed(fresh, encoded)).toBe(true)
    expect(
      archived.evidenceIds
        .flatMap((_id, i) =>
          i % 8 === 0 ? store.read(scope, archived.evidenceIds.slice(i, i + 8)) : [],
        )
        .map((hit) => hit.quote)
        .join(''),
    ).toBe('observation '.repeat(2000))
    expect(store.status().storedBytes).toBeLessThan(store.status().rawBytes)
  } finally {
    store.close()
  }
})

it('publishes durable archive frames from the separate worker and decodes them after process-worker restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cold-'))
  const path = join(dir, 'evidence.sqlite')
  const worker = new URL('../lib/worker.js', import.meta.url)
  const archive = new URL('../lib/archive-worker.js', import.meta.url)
  let store = new EvidenceStore(path, 'workspace', worker, archive)
  try {
    const text = 'Exact original bytes with a qualifier: unless I approve.\n'.repeat(1000)
    const old = await store.capture(scope, {
      id: 'old',
      role: 'tool',
      group: 'closed',
      closed: true,
      text,
    })
    const hot = await store.capture(scope, {
      id: 'hot',
      role: 'user',
      group: 'latest',
      closed: true,
      text: 'Continue.',
    })
    const state = await store.state(scope)
    for (let i = 0; i < 3; i++) {
      const input: ManifestInput = {
        request: requestRecipe(i, []),
        state,
        selected: [{ id: 'hot', mode: 'original', evidenceIds: hot.evidenceIds }],
        atomIds: [],
        requestHash: sha(String(i)),
        inputTokens: 10,
        rendererVersion: '1',
        adapterVersion: 'fixture',
      }
      await store.manifest(scope, input)
    }
    expect(await store.maintain(signal())).toBe(0)
    expect(await store.maintain(signal(), { now: Date.now() + 25 * 3600_000 })).toBe(1)
    const status = await store.status()
    expect(status.allocatedBytes).toBeGreaterThan(status.storedBytes)
    await store.close()
    store = new EvidenceStore(path, 'workspace', worker, archive)
    const hits = []
    for (let i = 0; i < old.evidenceIds.length; i += 8)
      hits.push(...(await store.read(scope, old.evidenceIds.slice(i, i + 8))))
    expect(hits.map((hit) => hit.quote).join('')).toBe(text)
    await store.close()
    if (status.archiveFileObjects > 0) {
      const framePath = join(dir, 'objects', `${sha(text)}.zstd.ev`)
      const frame = await readFile(framePath)
      frame[0] = 0
      await writeFile(framePath, frame)
      store = new EvidenceStore(path, 'workspace', worker, archive)
      await expect(store.read(scope, old.evidenceIds.slice(0, 8))).rejects.toThrow('corrupt')
    }
  } finally {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
