import { expect, it, vi } from 'vitest'
import { FalCatalog, parseFalModel } from '../src/catalog.ts'
import { FalGenerator } from '../src/generator.ts'

const metadata = {
  endpoint_id: 'fal-ai/edit',
  metadata: {
    display_name: 'Edit',
    category: 'image-to-image',
    status: 'active',
    kind: 'inference',
  },
}
const openapi = {
  paths: {
    '/model': {
      post: {
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Input' } } },
        },
      },
    },
  },
  components: {
    schemas: {
      Input: {
        type: 'object',
        required: ['image_urls', 'settings'],
        additionalProperties: false,
        properties: {
          image_urls: { type: 'array', items: { type: 'string' }, minItems: 1 },
          settings: {
            type: 'object',
            required: ['strength'],
            properties: { strength: { type: 'number', minimum: 0, maximum: 1 } },
          },
        },
      },
    },
  },
}

it('keeps documented model creation dates separate from updates and rejects ambiguous timestamps', () => {
  const date = '2026-02-26T16:20:09.685Z',
    updated_at = '2026-08-19T19:54:05.061Z'
  expect(
    parseFalModel({ ...metadata, metadata: { ...metadata.metadata, date, updated_at } }, 1),
  ).toMatchObject({ releasedAt: Date.parse(date), updatedAt: Date.parse(updated_at), fetchedAt: 1 })
  for (const date of [null, 2026, 'yesterday', '2026-02-26', '2026-02-26T10:00:00'])
    expect(
      parseFalModel({ ...metadata, metadata: { ...metadata.metadata, date, updated_at } }, 1)
        ?.releasedAt,
    ).toBeUndefined()
  expect(
    parseFalModel({ ...metadata, metadata: { ...metadata.metadata, updated_at } }, 1)?.releasedAt,
  ).toBeUndefined()
})

it('walks provider cursor pages, retains a real cached catalog, and never invents offline models', async () => {
  let clock = 1,
    offline = false
  const fetch = vi.fn(async (url: RequestInfo | URL) => {
    if (offline) throw new Error('offline')
    return new Response(
      JSON.stringify(
        String(url).includes('cursor=next')
          ? { models: [], next_cursor: null }
          : { models: [metadata], next_cursor: 'next' },
      ),
    )
  })
  const catalog = new FalCatalog({ fetch, now: () => clock })
  expect((await catalog.models()).map((model) => model.id)).toEqual(['fal-ai/edit'])
  await catalog.models()
  expect(fetch).toHaveBeenCalledTimes(2)
  clock += 600001
  offline = true
  expect((await catalog.models()).map((model) => model.id)).toEqual(['fal-ai/edit'])
  await expect(new FalCatalog({ fetch }).models()).rejects.toThrow('offline')
})

it('retrieves model schemas lazily and validates required nested inputs before inference', async () => {
  const transport = vi.fn(
    async () => new Response(JSON.stringify({ models: [{ ...metadata, openapi }] })),
  )
  const catalog = new FalCatalog({ fetch: transport })
  const model = await catalog.describe('fal-ai/edit')
  expect(model.protocol).toBe('fal')
  await catalog.describe(model.id)
  expect(transport).toHaveBeenCalledTimes(1)
  const inference = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ images: [] })),
  )
  const generator = new FalGenerator({ apiKey: () => 'fixture', fetch: inference })
  await expect(
    generator.generate({
      model: model.id,
      output: 'image',
      prompt: '',
      inputSchema: model.inputSchema,
      inputs: [{ kind: 'image', url: 'https://cdn.test/image.png', path: ['image_urls', 0] }],
      options: { settings: { strength: 2 } },
    }),
  ).rejects.toThrow('Invalid model input')
  expect(inference).not.toHaveBeenCalled()
  await generator.generate({
    model: model.id,
    output: 'image',
    prompt: '',
    inputSchema: model.inputSchema,
    inputs: [{ kind: 'image', url: 'https://cdn.test/image.png', path: ['image_urls', 0] }],
    options: { settings: { strength: 0.5 } },
  })
  expect(JSON.parse(inference.mock.calls[0]?.[1]?.body as string)).toEqual({
    image_urls: ['https://cdn.test/image.png'],
    settings: { strength: 0.5 },
  })
})

it('rejects remote schema references before inference', async () => {
  const document = {
    paths: {
      '/model': {
        post: {
          requestBody: {
            content: { 'application/json': { schema: { $ref: 'https://private.test/schema' } } },
          },
        },
      },
    },
  }
  const catalog = new FalCatalog({
    fetch: async () =>
      new Response(JSON.stringify({ models: [{ ...metadata, openapi: document }] })),
  })
  await expect(catalog.describe(metadata.endpoint_id)).rejects.toThrow('external references')
})
it('uses the queue result contract rather than the submission status envelope for model outputs', async () => {
  const { openApiSchema, validateMediaBody } = await import('@loncothad/dsh-media-gen')
  const document = {
    paths: {
      '/model': {
        post: {
          requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
          responses: {
            200: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Queue' } } },
            },
          },
        },
      },
      '/model/requests/{request_id}': {
        get: {
          responses: {
            200: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Output' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Queue: {
          type: 'object',
          required: ['status', 'request_id'],
          properties: { status: { type: 'string' }, request_id: { type: 'string' } },
        },
        Output: {
          type: 'object',
          required: ['model_mesh'],
          properties: {
            model_mesh: {
              type: 'object',
              required: ['url'],
              properties: { url: { type: 'string' } },
            },
          },
        },
      },
    },
  }
  const schema = openApiSchema(document, true)!
  expect(() =>
    validateMediaBody(schema, { model_mesh: { url: 'https://cdn.example/mesh.glb' } }),
  ).not.toThrow()
  expect(() => validateMediaBody(schema, { status: 'COMPLETED', request_id: 'queue' })).toThrow(
    'model_mesh',
  )
})

it('prices catalog pages in authenticated batches of at most fifty and keeps missing prices unknown', async () => {
  const transport = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Key fixture')
    const ids = new URL(String(url)).searchParams.getAll('endpoint_id')
    expect(ids.length).toBeLessThanOrEqual(50)
    return new Response(
      JSON.stringify({
        prices: ids
          .filter((id) => id !== 'fal-ai/missing')
          .map((endpoint_id) => ({
            endpoint_id,
            unit_price: 0.025,
            unit: 'image',
            currency: 'USD',
          })),
      }),
    )
  })
  const catalog = new FalCatalog({ apiKey: () => 'fixture', fetch: transport }),
    models = Array.from({ length: 60 }, (_, index) => ({
      id: index === 59 ? 'fal-ai/missing' : `fal-ai/model-${index}`,
      name: 'Model',
      outputs: ['image'] as const,
    }))
  const result = await catalog.priceModels(models)
  expect(transport).toHaveBeenCalledTimes(2)
  expect(result[0]?.pricing).toBe('USD 0.025/image')
  expect(result[59]?.pricing).toBeUndefined()
  await catalog.priceModels(models)
  expect(transport).toHaveBeenCalledTimes(2)
})
