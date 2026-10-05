import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type { MediaCatalogNamespace, MediaCatalogPage, MediaCatalogSort } from './catalog-wire.ts'
import {
  catalogOffset,
  catalogOutput,
  catalogSort,
  mediaCatalogContribution,
  parseMediaCatalogPage,
} from './catalog-wire.ts'
import type { MediaCatalogModel, MediaModality } from './media.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    falMediaCatalog: MediaCatalogService
    openrouterMediaCatalog: MediaCatalogService
  }
}
export class MediaCatalogService extends TypertRemoteService {
  private readonly lifetime = new AbortController()
  private pending?: Promise<readonly MediaCatalogModel[]>
  constructor(
    ctx: Context,
    namespace: MediaCatalogNamespace,
    private readonly models: (signal: AbortSignal) => Promise<readonly MediaCatalogModel[]>,
    private readonly describeModel?: (
      id: string,
      signal: AbortSignal,
    ) => Promise<MediaCatalogModel>,
    private readonly decoratePage?: (
      models: readonly MediaCatalogModel[],
      signal: AbortSignal,
    ) => Promise<readonly MediaCatalogModel[]>,
  ) {
    super(ctx, namespace)
    ctx.effect(
      () => () => this.lifetime.abort(new Error('Media catalog disposed')),
      'media catalog: cancel pending load',
    )
    const contribution = mediaCatalogContribution(namespace)
    ctx.typert.register({
      package: contribution.package,
      face: 'host',
      model: { services: [], events: [], objects: [] },
      schemas: [],
      invocations: contribution.descriptors,
    })
  }
  async describe(id: string): Promise<MediaCatalogModel> {
    if (!this.ctx.invocation) throw new Error('Media catalogs require the authenticated Gateway')
    if (typeof id !== 'string' || !id || id.length > 512) throw new Error('Invalid model ID')
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60000)])
    if (this.describeModel) return abortable(this.describeModel(id, signal), signal)
    const model = (await abortable(this.models(signal), signal)).find((model) => model.id === id)
    if (!model) throw new Error('Model is not in this provider catalog')
    return model
  }
  async list(
    output: MediaModality,
    query: string,
    offset: number,
    sort: MediaCatalogSort,
  ): Promise<MediaCatalogPage> {
    if (!this.ctx.invocation) throw new Error('Media catalogs require the authenticated Gateway')
    catalogOutput(output)
    catalogOffset(offset)
    const ordering = catalogSort(sort)
    if (typeof query !== 'string' || query.length > 256)
      throw new Error('Invalid media catalog query')
    this.lifetime.signal.throwIfAborted()
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60000)])
    this.pending ??= abortable(this.models(signal), signal).finally(() => {
      if (this.pending === pending) this.pending = undefined
    })
    const pending = this.pending
    const models = await pending
    this.lifetime.signal.throwIfAborted()
    if (models.length > 100000) throw new Error('Media catalog exceeds its model budget')
    const search = query.trim().toLowerCase()
    const matching = models.filter(
      (model) =>
        model.outputs.includes(output) &&
        (!search || `${model.id} ${model.name}`.toLowerCase().includes(search)),
    )
    if (ordering === 'newest')
      matching.sort(
        (a, b) =>
          (b.releasedAt ?? -1) - (a.releasedAt ?? -1) ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      )
    else if (ordering === 'name')
      matching.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    const base = matching.slice(offset, offset + 100)
    const page = this.decoratePage ? await abortable(this.decoratePage(base, signal), signal) : base
    return parseMediaCatalogPage({
      models: page,
      total: matching.length,
      ...(offset + page.length < matching.length ? { next: offset + page.length } : {}),
    })
  }
}
export function registerMediaCatalog(
  ctx: Context,
  namespace: MediaCatalogNamespace,
  models: (signal: AbortSignal) => Promise<readonly MediaCatalogModel[]>,
  describe?: (id: string, signal: AbortSignal) => Promise<MediaCatalogModel>,
  decoratePage?: (
    models: readonly MediaCatalogModel[],
    signal: AbortSignal,
  ) => Promise<readonly MediaCatalogModel[]>,
): void {
  ctx.inject(['typert'], (scope) => {
    new MediaCatalogService(scope, namespace, models, describe, decoratePage)
  })
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
