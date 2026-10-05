import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { type PluginStatusView, parsePluginStatus, statusContribution } from './status-wire.ts'

class Status extends TypertRemoteService {
  constructor(
    ctx: Context,
    id: string,
    private readonly read: () => PluginStatusView,
  ) {
    super(ctx, `pluginStatus_${id}`)
    const contribution = statusContribution(id)
    ctx.typert.register({
      package: contribution.package,
      face: 'host',
      model: { services: [], events: [], objects: [] },
      schemas: [],
      invocations: contribution.descriptors,
    })
  }
  state(): PluginStatusView {
    if (!this.ctx.invocation) throw new Error('Status requires the authenticated Gateway')
    return parsePluginStatus(this.read())
  }
}
/** Shared readiness metadata for multiple capability pages. No control or credential methods are exposed. */
export function registerStatus(ctx: Context, id: string, read: () => PluginStatusView): void {
  ctx.inject(['typert'], (scope) => {
    new Status(scope, id, read)
  })
}
