import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { EvidenceStore, requestRecipe } from '../src/index.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
const scope = { workspaceId: 'workspace', sessionId: 'session' }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

it('reconstructs complete requests after worker restart without copying large original text into manifests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-request-replay-'))
  dirs.push(dir)
  const path = join(dir, 'evidence.sqlite'),
    worker = new URL('../lib/worker.js', import.meta.url)
  let store = new EvidenceStore(path, scope.workspaceId, worker)
  try {
    const quote = 'Original observation 🪼; deployment is NOT approved.\n'.repeat(7000)
    const captured = await store.capture(scope, {
      id: 'large-tool',
      role: 'tool',
      group: 'closed',
      closed: true,
      text: quote,
    })
    const request = {
      provider: 'fixture',
      model: 'exact-model',
      maxTokens: 1500,
      system: 'Current instructions.',
      tools: [
        {
          name: 'read_only',
          parameters: { type: 'object', properties: { id: { type: 'string' } } },
        },
      ],
      messages: [
        { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: quote }] },
        { role: 'user', content: [{ type: 'text', text: 'Continue carefully.' }] },
      ],
    }
    const recipe = requestRecipe(request, [
      {
        value: quote,
        ids: captured.evidenceIds,
        startByte: 0,
        endByte: Buffer.byteLength(quote),
        encoding: 'text',
      },
    ])
    expect(JSON.stringify(recipe).length).toBeLessThan(6000)
    expect(JSON.stringify(recipe)).not.toContain('deployment is NOT approved')
    const manifest = await store.manifest(scope, {
      request: recipe,
      state: await store.state(scope),
      selected: [{ id: 'large-tool', mode: 'original', evidenceIds: captured.evidenceIds }],
      atomIds: [],
      requestHash: hash(request),
      inputTokens: 1000,
      rendererVersion: 'recipe-v1',
      adapterVersion: 'fixture-v1',
    })
    await store.close()
    store = new EvidenceStore(path, scope.workspaceId, worker)
    expect(await store.replayRequest(scope, manifest.id)).toEqual(request)
    await expect(
      store.replayRequest({ ...scope, sessionId: 'other' }, manifest.id),
    ).rejects.toThrow('unavailable')
    await store.delete(scope, 'large-tool')
    await expect(store.replayRequest(scope, manifest.id)).rejects.toThrow('unavailable')
  } finally {
    await store.close()
  }
})

it('rejects unselected references and hash mismatches before publishing a manifest', async () => {
  const store = new EvidenceStore(
    ':memory:',
    scope.workspaceId,
    new URL('../lib/worker.js', import.meta.url),
  )
  try {
    const text = 'An exact original qualifier.'
    const captured = await store.capture(scope, {
      id: 'original',
      role: 'user',
      group: 'closed',
      closed: true,
      text,
    })
    const request = requestRecipe(text, [
      {
        value: text,
        ids: captured.evidenceIds,
        startByte: 0,
        endByte: Buffer.byteLength(text),
        encoding: 'text',
      },
    ])
    const input = {
      request,
      state: await store.state(scope),
      selected: [],
      atomIds: [],
      requestHash: hash(text),
      inputTokens: 10,
      rendererVersion: '1',
      adapterVersion: 'fixture',
    }
    await expect(store.manifest(scope, input)).rejects.toThrow('unselected')
    await expect(
      store.manifest(scope, {
        ...input,
        selected: [{ id: 'original', mode: 'original', evidenceIds: captured.evidenceIds }],
        requestHash: hash('different'),
      }),
    ).rejects.toThrow('hash mismatch')
  } finally {
    await store.close()
  }
})

it('rejects deleted selected evidence even when derived request text is stored inline', async () => {
  const store = new EvidenceStore(
    ':memory:',
    scope.workspaceId,
    new URL('../lib/worker.js', import.meta.url),
  )
  try {
    const captured = await store.capture(scope, {
      id: 'qualifier',
      role: 'user',
      group: 'closed',
      closed: true,
      text: 'Only after explicit approval.',
    })
    const value = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Derived historical memory.' }] }],
    }
    const manifest = await store.manifest(scope, {
      request: requestRecipe(value, []),
      state: await store.state(scope),
      selected: [{ id: 'memory-source', mode: 'original', evidenceIds: captured.evidenceIds }],
      atomIds: [],
      requestHash: hash(value),
      inputTokens: 10,
      rendererVersion: '1',
      adapterVersion: 'fixture',
    })
    expect(await store.replayRequest(scope, manifest.id)).toEqual(value)
    await store.delete(scope, 'qualifier')
    await expect(store.replayRequest(scope, manifest.id)).rejects.toThrow('unavailable')
  } finally {
    await store.close()
  }
})
