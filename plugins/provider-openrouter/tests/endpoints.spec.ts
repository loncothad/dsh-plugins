import { describe, expect, it, vi } from 'vitest'
import { fetchEndpoints, parseEndpoints, routingPreference } from '../src/index.ts'

describe('upstream routing and endpoint evidence', () => {
  it('routes canonical models independently and applies privacy constraints', () => {
    const config = {
      modelProviders: { 'a/model': 'deepinfra/turbo' },
      zeroDataRetention: true,
      denyDataCollection: true,
    }
    expect(routingPreference(config, 'a/model', 'azure')).toEqual({
      provider: {
        order: ['deepinfra/turbo'],
        allow_fallbacks: false,
        zdr: true,
        data_collection: 'deny',
      },
    })
    expect(routingPreference(config, 'b/model', 'azure')).toMatchObject({
      provider: { order: ['azure'] },
    })
    expect(routingPreference({}, 'b/model')).toBeUndefined()
  })

  it('does not interpret missing or invalid metrics as zero or ZDR', () => {
    const rows = parseEndpoints(
      {
        data: {
          architecture: { output_modalities: ['text'] },
          endpoints: [
            {
              tag: 'azure',
              provider_name: 'Azure',
              model_id: 'a/model',
              pricing: { prompt: '0.000003', completion: '-1' },
              latency_last_30m: null,
              throughput_last_30m: { p50: 35 },
              uptime_last_1d: 99.8,
            },
            { tag: 'other', model_id: 'a/model', pricing: { prompt: '' }, uptime_last_1d: 999 },
          ],
        },
      },
      { data: [{ slug: 'azure', privacy_policy_url: 'https://example.test/privacy' }] },
      { data: [{ tag: 'azure', model_id: 'a/model' }] },
    )
    expect(rows[0]).toMatchObject({
      inputPrice: 3,
      throughput: 35,
      uptime: 99.8,
      zeroRetention: true,
      privacyUrl: 'https://example.test/privacy',
    })
    expect(rows[0]).not.toHaveProperty('latency')
    expect(rows[0]).not.toHaveProperty('outputPrice')
    expect(rows[1]).not.toHaveProperty('zeroRetention')
    expect(rows[1]).not.toHaveProperty('uptime')
    expect(rows[1]).not.toHaveProperty('inputPrice')
  })

  it('preserves available metrics when optional policy catalogs fail', async () => {
    const transport = vi.fn(async (url: string) =>
      url.endsWith('/endpoints')
        ? new Response(
            JSON.stringify({ data: { endpoints: [{ tag: 'azure', model_id: 'a/model' }] } }),
          )
        : new Response('', { status: 503 }),
    )
    expect(await fetchEndpoints('a/model', undefined, transport as typeof fetch)).toMatchObject([
      { tag: 'azure', name: 'azure', provider: 'azure', prices: [] },
    ])
    expect(transport.mock.calls[0]?.[0]).toBe(
      'https://openrouter.ai/api/v1/models/a/model/endpoints',
    )
    await expect(fetchEndpoints('invalid', undefined, transport as typeof fetch)).rejects.toThrow(
      'canonical',
    )
  })
})
