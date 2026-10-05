import type { Context } from '@deepseek-ai/cordis'
import type { DecisionInput, DecisionResult } from './types.ts'
import { parseDecisionResult, validateDecisionInput } from './validation.ts'
export interface DecisionProvider {
  id: string
  models: readonly string[]
  images: boolean
  defaultModel?: string
  evaluate(model: string, input: DecisionInput, signal: AbortSignal): Promise<DecisionResult>
}
export class DecisionRegistry {
  private readonly providers = new Map<string, DecisionProvider>()
  register(ctx: Context, provider: DecisionProvider): void {
    if (this.providers.has(provider.id))
      throw new Error(`Decision provider ${provider.id} is already registered`)
    this.providers.set(provider.id, provider)
    ctx.effect(
      () => () => {
        if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id)
      },
      `decision provider: ${provider.id}`,
    )
  }
  list() {
    return [...this.providers.values()].map(({ id, models, images }) => ({ id, models, images }))
  }
  async evaluate(
    providerId: string,
    model: string,
    raw: DecisionInput,
    signal: AbortSignal,
  ): Promise<DecisionResult> {
    const provider = this.providers.get(providerId)
    if (!provider) throw new Error(`Enable and configure decision provider ${providerId}`)
    if (model === 'default' && provider.defaultModel) model = provider.defaultModel
    if (!provider.models.includes(model)) throw new Error('This decision model is not registered')
    const input = validateDecisionInput(raw)
    if (input.images?.length && !provider.images)
      throw new Error('This decision provider does not support embedded images')
    signal.throwIfAborted()
    const result = await provider.evaluate(model, input, signal)
    signal.throwIfAborted()
    if (this.providers.get(providerId) !== provider)
      throw new Error('Decision provider changed during execution')
    return parseDecisionResult(result, input)
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    decisionProviders: DecisionRegistry
  }
}
export function decisionRegistry(ctx: Context): DecisionRegistry {
  let registry = ctx.get('decisionProviders')
  if (!registry) {
    registry = new DecisionRegistry()
    ctx.root.provide('decisionProviders', registry)
  }
  return registry
}
