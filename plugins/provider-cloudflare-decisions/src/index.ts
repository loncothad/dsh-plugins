import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  type DecisionInput,
  decisionRegistry,
  parseDecisionResult,
  validateDecisionInput,
} from '@loncothad/dsh-decision-core'
import {
  credentialValue,
  editableConfig,
  managedApply,
  subscriptionJson,
} from '@loncothad/dsh-plugin-runtime'
import { validateImages } from './images.ts'
export const name = 'provider-cloudflare-decisions'
export const ConfigSchema = z.object({
  enabled: z.boolean().default(true),
  accountId: z
    .string()
    .default('')
    .description('Cloudflare account ID; empty uses CLOUDFLARE_ACCOUNT_ID.'),
  apiToken: z
    .string()
    .role('secret')
    .description('Workers AI API token; empty uses CLOUDFLARE_API_TOKEN.'),
  model: z.union(['clef', 'clef-flash']).default('clef-flash'),
  visionEnabled: z.boolean().default(true),
  timeoutMs: z.number().step(1).min(1000).max(300000).default(30000),
  maxConcurrentRequests: z.number().step(1).min(1).max(32).default(4),
})
export async function requestCloudflare(
  options: {
    accountId: string
    token: string
    model: string
    visionEnabled: boolean
    fetch?: typeof fetch
  },
  raw: DecisionInput,
  signal: AbortSignal,
) {
  if (!/^[a-f0-9]{32}$/i.test(options.accountId))
    throw new Error('Configure a valid Cloudflare account ID')
  if (!options.token) throw new Error('Configure a Cloudflare Workers AI token')
  if (!['clef', 'clef-flash'].includes(options.model)) throw new Error('Choose Clef or Clef Flash')
  const input = validateDecisionInput(raw)
  if (input.images?.length) {
    if (!options.visionEnabled) throw new Error('Cloudflare vision inputs are disabled')
    validateImages(input.images)
  }
  const response = await subscriptionJson(
    `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/run/@cf/cloudflare/${options.model}`,
    { Authorization: `Bearer ${options.token}` },
    signal,
    options.fetch,
    { model: options.model, ...input },
  )
  return parseDecisionResult(response, input)
}
function activate(ctx: Context, config: ReturnType<typeof ConfigSchema>) {
  const lifetime = new AbortController()
  let concurrent = 0
  ctx.effect(() => () => lifetime.abort(), 'Cloudflare decisions: cancel requests')
  decisionRegistry(ctx).register(ctx, {
    id: 'cloudflare',
    models: ['clef', 'clef-flash'],
    defaultModel: config.model,
    images: config.visionEnabled,
    evaluate: async (model, input, signal) => {
      if (!config.enabled) throw new Error('Cloudflare Decisions is disabled')
      if (concurrent >= config.maxConcurrentRequests)
        throw new Error('Cloudflare decision concurrency limit reached')
      ctx.get('environmentIsolation')?.assert()
      concurrent++
      try {
        return await requestCloudflare(
          {
            accountId: config.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || '',
            token:
              credentialValue(ctx, () => config.apiToken || process.env.CLOUDFLARE_API_TOKEN) || '',
            model,
            visionEnabled: config.visionEnabled,
          },
          input,
          AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(config.timeoutMs)]),
        )
      } finally {
        concurrent--
      }
    },
  })
}
export const Config = editableConfig(ConfigSchema)
export const apply = managedApply(ConfigSchema, activate)
