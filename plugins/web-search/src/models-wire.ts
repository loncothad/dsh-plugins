import type {
  RemoteResult,
  TypertCodec,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
export const searchCatalogSchema = z
  .object({
    available: z.boolean(),
    reason: z.string().max(512).optional(),
    models: z
      .array(z.object({ id: z.string().min(1).max(512), name: z.string().max(512) }).strict())
      .max(2048),
  })
  .strict()
export type SearchCatalog = z.infer<typeof searchCatalogSchema>
export interface SearchModelsRemote {
  list(provider: 'api' | 'codex'): Promise<RemoteResult<SearchCatalog>>
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    webSearchModels: SearchModelsRemote
  }
}
const codec = (symbol: string, parse: (v: unknown) => unknown): TypertCodec => ({
  mode: 'strict',
  typeSymbol: `@loncothad/dsh-web-search/models#${symbol}`,
  create: () => ({ parse }),
})
export const searchModelsContribution: TypertRemoteContribution = {
  package: '@loncothad/dsh-web-search.models',
  descriptors: [
    {
      id: 'webSearchModels/list',
      namespace: 'webSearchModels',
      service: 'webSearchModels',
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'provider',
          wire: 'provider',
          source: 'json',
          codec: codec('Provider', (v) => z.enum(['api', 'codex']).parse(v)),
        },
      ],
      result: codec('Catalog', (v) => searchCatalogSchema.parse(v)),
    },
  ],
}
