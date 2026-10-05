/**
 * The two Z.AI provider adapters over the shared OpenAI-compatible base.
 * Keys resolve per call: the stored subscription first (the subscription login
 * outcome), then plugin config, then the launching environment.
 *
 * @module @loncothad/dsh-provider-zai/provider
 */

import type { CatalogModel } from '@loncothad/dsh-llm-openai-compat'
import { OpenAICompatAdapter } from '@loncothad/dsh-llm-openai-compat'
import {
  ZAI_CODING_CN_ENDPOINT,
  ZAI_CODING_CN_MODELS,
  ZAI_ENDPOINT,
  ZAI_MODELS,
} from './catalog.ts'

/** Resolved adapter options for both routes. */
export interface ZaiProviderOptions {
  readonly lifetime?: AbortSignal
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
  readonly codingCnFetch?: typeof fetch
  /** Resolves the stored subscription per call (route `zai`); undefined when none. */
  readonly store: () => Promise<{ apiKey?: string } | undefined>
  /** Z.AI key (config fallback for route `zai`). */
  readonly apiKey: () => string | undefined
  /** Z.AI Coding CN key (route `zai-coding-cn`). */
  readonly codingCnApiKey: () => string | undefined
  /** Endpoint overrides for gateways. */
  readonly endpoint?: string
  readonly codingCnEndpoint?: string
}

/** Build both route adapters. */
export function createZaiProviders(options: ZaiProviderOptions): {
  zai: OpenAICompatAdapter
  codingCn: OpenAICompatAdapter
} {
  return {
    zai: new OpenAICompatAdapter({
      lifetime: options.lifetime,
      timeoutMs: options.timeoutMs,
      fetch: options.fetch,
      provider: 'zai',
      providerName: 'Z.AI GLM (subscription)',
      endpoint: options.endpoint ?? ZAI_ENDPOINT,
      apiKey: async () => (await options.store())?.apiKey ?? options.apiKey(),
      models: ZAI_MODELS,
    }),
    codingCn: new OpenAICompatAdapter({
      lifetime: options.lifetime,
      timeoutMs: options.timeoutMs,
      fetch: options.codingCnFetch ?? options.fetch,
      provider: 'zai-coding-cn',
      providerName: 'Z.AI GLM Coding CN (subscription)',
      endpoint: options.codingCnEndpoint ?? ZAI_CODING_CN_ENDPOINT,
      apiKey: options.codingCnApiKey,
      models: ZAI_CODING_CN_MODELS,
    }),
  }
}

export type { CatalogModel }
