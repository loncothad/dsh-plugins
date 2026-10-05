import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { expect, it, vi } from 'vitest'
import { parseMediaCatalogPage } from '../../../support/media-gen/src/catalog-wire.ts'
import { apply } from '../src/index.ts'

it('exposes host-catalog configuration when generation surfaces are disabled', async () => {
  const ctx = new Context(),
    peerContext = new Context()
  try {
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(Gateway)
    apply(
      ctx,
      { mediaEnabled: false },
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  endpoint_id: 'fal-ai/image',
                  metadata: { category: 'text-to-image', status: 'active' },
                },
              ],
            }),
          ),
      },
    )
    await vi.waitFor(() => expect(ctx.get('falMediaCatalog')).toBeDefined())
    const peer: PeerScope = {
      id: 'owner' as PeerId,
      ctx: peerContext,
      dispose: () => peerContext.fiber.dispose(),
    }
    const page = parseMediaCatalogPage(
      await ctx.typertGateway.invoke({
        namespace: 'falMediaCatalog',
        method: 'list',
        args: { output: 'image', query: '', offset: 0, sort: 'newest' },
        peer,
      }),
    )
    expect(page.models.length).toBeGreaterThan(0)
    expect(page.models.every((model) => model.outputs.includes('image'))).toBe(true)
    expect(ctx.get('tools')).toBeUndefined()
  } finally {
    await peerContext.fiber.dispose()
    await ctx.fiber.dispose()
  }
})
