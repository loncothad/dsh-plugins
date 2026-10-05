import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { controlContribution, type EvidenceView, parseEvidenceView } from './control-wire.ts'
import type { EvidenceCompactorManager } from './manager.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    evidenceControl: EvidenceControl
  }
}
export class EvidenceControl extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly manager: EvidenceCompactorManager,
  ) {
    super(ctx, 'evidenceControl')
    ctx.typert.register({
      package: controlContribution.package,
      face: 'host',
      model: { services: [], events: [], objects: [] },
      schemas: [],
      invocations: controlContribution.descriptors,
    })
  }
  state(): EvidenceView {
    if (!this.ctx.invocation)
      throw new Error('Compactor controls require the authenticated Gateway')
    return parseEvidenceView(this.manager.view())
  }
  async install(): Promise<EvidenceView> {
    if (!this.ctx.invocation)
      throw new Error('Compactor controls require the authenticated Gateway')
    await this.manager.install().catch(() => {})
    return this.state()
  }
}
