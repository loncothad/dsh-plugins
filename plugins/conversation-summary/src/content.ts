import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type {} from '@loncothad/dsh-execution-core'
import { contentContribution } from './content-wire.ts'
export function registerSummaryContent(ctx: Context): void {
  ctx.inject(['typert', 'executionRecovery'], (scope) => {
    new SummaryContent(scope)
  })
}
class SummaryContent extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'conversationSummaryContent')
    ctx.typert.register({
      package: contentContribution.package,
      face: 'host',
      model: { services: [], events: [], objects: [] },
      schemas: [],
      invocations: contentContribution.descriptors,
    })
  }
  async read(sessionId: string, reference: string): Promise<string> {
    if (!this.ctx.invocation)
      throw new Error('Summary content requires the authenticated human Gateway')
    if (!/^[a-f0-9]{64}$/.test(reference)) throw new Error('Invalid summary reference')
    const result = await this.ctx.executionRecovery.readResult<{ text: string }>(
      sessionId,
      reference,
      'conversation-summary',
    )
    if (!result || typeof result.text !== 'string' || !result.text || result.text.length > 65536)
      throw new Error('Summary content is unavailable')
    return result.text
  }
}
