import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { expect, it, vi } from 'vitest'
import { MediaCatalogService } from '../src/catalog-service.ts'
import { parseMediaCatalogPage } from '../src/catalog-wire.ts'
import type { MediaCatalogModel } from '../src/media.ts'

it('pages and filters provider capabilities through the real authenticated Gateway and joins concurrent loads', async () => {
  const ctx = new Context(),
    peerContext = new Context()
  try {
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(Gateway)
    const models: MediaCatalogModel[] = Array.from({ length: 205 }, (_, index) => ({
      id: `vendor/image-${index}`,
      name: `Image ${index}`,
      outputs: ['image'],
      inputs: ['text'],
      pricing: '$0.1/image',
    }))
    models.push({ id: 'vendor/video', name: 'Motion', outputs: ['video'], inputs: ['image'] })
    const gate = Promise.withResolvers<readonly MediaCatalogModel[]>()
    const load = vi.fn(() => gate.promise)
    const service = new MediaCatalogService(ctx, 'falMediaCatalog', load)
    await expect(service.list('image', '', 0, 'provider')).rejects.toThrow('authenticated Gateway')
    const peer: PeerScope = {
      id: 'catalog-owner' as PeerId,
      ctx: peerContext,
      dispose: () => peerContext.fiber.dispose(),
    }
    const call = (output: string, query = '', offset = 0) =>
      ctx.typertGateway.invoke({
        namespace: 'falMediaCatalog',
        method: 'list',
        args: { output, query, offset, sort: 'provider' },
        peer,
      })
    const first = call('image'),
      second = call('video')
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    gate.resolve(models)
    expect(parseMediaCatalogPage(await first)).toMatchObject({
      total: 205,
      next: 100,
      models: expect.any(Array),
    })
    expect(parseMediaCatalogPage(await second)).toEqual({
      total: 1,
      models: [{ id: 'vendor/video', name: 'Motion', outputs: ['video'], inputs: ['image'] }],
    })
    expect(parseMediaCatalogPage(await call('image', '', 200))).toMatchObject({
      total: 205,
      models: expect.arrayContaining([
        {
          id: 'vendor/image-204',
          name: 'Image 204',
          outputs: ['image'],
          inputs: ['text'],
          pricing: '$0.1/image',
        },
      ]),
    })
    expect(parseMediaCatalogPage(await call('image', 'image-204')).models).toHaveLength(1)
    await expect(call('unknown')).rejects.toThrow()
    await expect(call('image', '', -1)).rejects.toThrow()
  } finally {
    await peerContext.fiber.dispose()
    await ctx.fiber.dispose()
  }
})

it('strips unexpected fields and rejects malformed provider catalog pages', () => {
  const value = {
    models: [
      {
        id: 'm',
        name: 'Model',
        outputs: ['audio'],
        apiKey: 'private',
        parameters: { duration: { type: 'number', values: [4, 8] } },
      },
    ],
    total: 1,
  }
  expect(JSON.stringify(parseMediaCatalogPage(value))).not.toContain('private')
  expect(parseMediaCatalogPage(value).models[0]?.parameters).toEqual({
    duration: { type: 'number', values: [4, 8] },
  })
  expect(() =>
    parseMediaCatalogPage({ ...value, models: [{ id: 'm', name: 'Model', outputs: ['unknown'] }] }),
  ).toThrow('output')
  expect(() =>
    parseMediaCatalogPage({ ...value, models: Array(101).fill(value.models[0]) }),
  ).toThrow('page')
})

it('sorts the entire filtered catalog before pagination, with unknown releases last and updates ignored', async () => {
  const ctx = new Context(),
    peerContext = new Context()
  try {
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(Gateway)
    const models: MediaCatalogModel[] = Array.from({ length: 105 }, (_, i) => ({
      id: `m-${i}`,
      name: `Model ${i}`,
      outputs: ['image'],
      releasedAt: i + 1,
    }))
    models.unshift({ id: 'unknown', name: 'A', outputs: ['image'], updatedAt: 999999 })
    new MediaCatalogService(ctx, 'falMediaCatalog', async () => models)
    const peer: PeerScope = {
      id: 'owner' as PeerId,
      ctx: peerContext,
      dispose: () => peerContext.fiber.dispose(),
    }
    const call = (sort: string, offset = 0) =>
      ctx.typertGateway.invoke({
        namespace: 'falMediaCatalog',
        method: 'list',
        args: { output: 'image', query: '', offset, sort },
        peer,
      })
    const page = parseMediaCatalogPage(await call('newest'))
    expect(page.models[0]).toMatchObject({ id: 'm-104', releasedAt: 105 })
    expect(page.next).toBe(100)
    expect(parseMediaCatalogPage(await call('newest', 100)).models.at(-1)?.id).toBe('unknown')
    expect(parseMediaCatalogPage(await call('name')).models[0]?.id).toBe('unknown')
    expect(parseMediaCatalogPage(await call('provider')).models[0]?.id).toBe('unknown')
    await expect(call('updated')).rejects.toThrow('sort')
    expect(models[0]?.id).toBe('unknown')
  } finally {
    await peerContext.fiber.dispose()
    await ctx.fiber.dispose()
  }
})

it('validates release and update dates at the catalog wire boundary', () => {
  const model = { id: 'm', name: 'Model', outputs: ['image'] }
  expect(
    parseMediaCatalogPage({ models: [{ ...model, releasedAt: 1, updatedAt: 2 }], total: 1 })
      .models[0],
  ).toMatchObject({ releasedAt: 1, updatedAt: 2 })
  for (const value of [-1, Infinity, '2026-01-01', 1.5])
    expect(() =>
      parseMediaCatalogPage({ models: [{ ...model, releasedAt: value }], total: 1 }),
    ).toThrow('timestamp')
})

it('cancels a pending catalog load when its provider generation is disposed', async () => {
  const ctx = new Context(),
    peerContext = new Context()
  try {
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(Gateway)
    let signal: AbortSignal | undefined
    const fiber = ctx.plugin({
      inject: ['typert'],
      apply(scope: Context) {
        new MediaCatalogService(scope, 'openrouterMediaCatalog', async (current) => {
          signal = current
          return new Promise(() => {})
        })
      },
    })
    await fiber.await()
    const peer: PeerScope = {
      id: 'owner' as PeerId,
      ctx: peerContext,
      dispose: () => peerContext.fiber.dispose(),
    }
    const request = ctx.typertGateway.invoke({
      namespace: 'openrouterMediaCatalog',
      method: 'list',
      args: { output: 'video', query: '', offset: 0, sort: 'provider' },
      peer,
    })
    const rejected = expect(request).rejects.toThrow('disposed')
    await vi.waitFor(() => expect(signal).toBeDefined())
    await fiber.dispose()
    await rejected
    expect(signal?.aborted).toBe(true)
  } finally {
    await peerContext.fiber.dispose()
    await ctx.fiber.dispose()
  }
})
