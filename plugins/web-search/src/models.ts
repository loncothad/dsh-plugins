import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { optionalString } from '@loncothad/dsh-plugin-runtime'
import type { Config } from './index.ts'
import { type SearchCatalog, searchCatalogSchema, searchModelsContribution } from './models-wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webSearchModels: SearchModels
  }
}
class SearchModels extends TypertRemoteService {
  private lifetime = new AbortController()
  constructor(
    ctx: Context,
    private config: Config,
  ) {
    super(ctx, 'webSearchModels')
    ctx.effect(() => () => this.lifetime.abort(), 'search catalog: cancel')
    ctx.typert.register({
      package: searchModelsContribution.package,
      face: 'host',
      model: { services: [], events: [], objects: [] },
      schemas: [],
      invocations: searchModelsContribution.descriptors,
    })
  }
  async list(provider: 'api' | 'codex'): Promise<SearchCatalog> {
    if (!this.ctx.invocation) throw Error('Model catalog requires the authenticated Gateway')
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15000)])
    if (provider === 'codex') {
      if (!this.ctx.get('codexSubscription')?.account())
        return {
          available: false,
          reason: 'Sign in and select an account in ChatGPT Codex.',
          models: [],
        }
      const models = await this.ctx.llm.listModels('codex')
      return searchCatalogSchema.parse({
        available: true,
        models: models.slice(0, 2048).map((m) => ({ id: m.id, name: m.name ?? m.id })),
      })
    }
    const key = optionalString(this.config.openaiApiKey) ?? process.env.OPENAI_API_KEY
    if (!key?.trim())
      return {
        available: false,
        reason: 'Configure an OpenAI API key and save before loading models.',
        models: [],
      }
    const response = await fetch(
      `${(this.config.openaiBaseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/models`,
      { headers: { authorization: `Bearer ${key}` }, redirect: 'error', signal },
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw Error(`OpenAI model catalog unavailable (HTTP ${response.status})`)
    }
    const reader = response.body?.getReader()
    if (!reader) throw Error('Empty model catalog')
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const r = await reader.read()
        if (r.done) break
        bytes += r.value.byteLength
        if (bytes > 1048576) throw Error('Model catalog exceeds one MiB')
        chunks.push(r.value)
      }
    } finally {
      await reader.cancel()
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      data?: { id?: unknown }[]
    }
    return searchCatalogSchema.parse({
      available: true,
      models: (payload.data ?? [])
        .filter((m) => typeof m.id === 'string')
        .slice(0, 2048)
        .map((m) => ({ id: m.id, name: m.id }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    })
  }
}
export function registerSearchModels(ctx: Context, config: Config) {
  ctx.inject(['typert', 'llm'], (scope) => {
    new SearchModels(scope, config)
  })
}
