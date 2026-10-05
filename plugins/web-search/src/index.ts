import { editableConfig, managedApply, optionalString } from '@loncothad/dsh-plugin-runtime'
/**
 * Unified web search for dsh: one plugin mounting the workspace's search
 * providers onto the `ctx.web` seam. Each provider activates when its key
 * resolves (config first, then the launching environment); the harness's
 * `web` row `searchProvider` setting (or `DSH_WEB_SEARCH_PROVIDER`) picks
 * which one serves `web_search`.
 *
 * Currently mounts: Kagi, OpenRouter (hosted web plugin), Exa (REST with
 * keyless MCP fallback), and OpenAI/Codex (Responses `web_search` — the
 * Codex subscription path resolves through the credentials seam when a
 * Codex account from @loncothad/dsh-provider-openai-codex is signed in,
 * and a separate OpenAI API key provider).
 *
 * @module @loncothad/dsh-web-search
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-web'
import z from '@deepseek-ai/schemastery'
import { registerSearchModels } from './models.ts'
import {
  ExaSearchProvider,
  KAGI_DEFAULT_BASE_URL,
  KagiSearchProvider,
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_MODEL,
  OpenAIResponsesSearchProvider,
  OpenRouterSearchProvider,
} from './providers.ts'

export { searchFailure } from './http.ts'
export * from './providers.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search'

/** The seam this plugin registers into.  The credentials seam is looked
 * up optionally per request: the OpenAI provider's Codex-subscription path
 * uses it when present, and every other provider works without it, so a
 * deployment without a credentials service still gets search. */
export const inject = ['web']

/** Plugin config; every field has an environment-variable fallback. */
export interface Config {
  /** Kagi key. Falls back to `$KAGI_API_KEY`. */
  kagiEnabled?: boolean
  openrouterEnabled?: boolean
  exaEnabled?: boolean
  codexEnabled?: boolean
  openaiEnabled?: boolean
  codexModel?: string
  openaiModel?: string
  searchTimeoutMs?: number
  kagiApiKey?: string
  /** Kagi endpoint base. */
  kagiBaseUrl?: string
  /** Kagi default result count when a request carries no `maxResults`. */
  kagiLimit?: number
  /** OpenRouter key. Falls back to `$OPENROUTER_API_KEY`. */
  openrouterApiKey?: string
  /** OpenRouter endpoint base. */
  openrouterBaseUrl?: string
  /** Model carrying OpenRouter's hosted web plugin. */
  openrouterModel?: string
  /** Exa key. Falls back to `$EXA_API_KEY`; without it the keyless MCP fallback serves. */
  exaApiKey?: string
  /** Exa endpoint base. */
  exaBaseUrl?: string
  /** OpenAI key for the Responses `web_search` path. Falls back to `$OPENAI_API_KEY`. */
  openaiApiKey?: string
  /** OpenAI Responses endpoint override. */
  openaiBaseUrl?: string
}

const BaseConfig = z.object({
  kagiEnabled: z.boolean().default(false),
  openrouterEnabled: z.boolean().default(false),
  exaEnabled: z.boolean().default(true),
  codexEnabled: z.boolean().default(false),
  openaiEnabled: z.boolean().default(false),
  codexModel: z
    .string()
    .default('gpt-6-luna')
    .description(
      'Subscription model with web_search support. Uses the active ChatGPT Codex account and its refresh service.',
    ),
  openaiModel: z
    .string()
    .default('gpt-4.1-mini')
    .description(
      'OpenAI API model with Responses web_search support. Billed to the API key account.',
    ),
  searchTimeoutMs: z.number().step(1).min(1000).max(900000).default(60000),
  kagiApiKey: z.string().role('secret'),
  kagiBaseUrl: z.string(),
  kagiLimit: z.number().step(1).min(1),
  openrouterApiKey: z.string().role('secret'),
  openrouterBaseUrl: z.string(),
  openrouterModel: z.string(),
  exaApiKey: z.string().role('secret'),
  exaBaseUrl: z.string(),
  openaiApiKey: z.string().role('secret'),
  openaiBaseUrl: z.string(),
})

/** Register the workspace's search providers with `ctx.web`. */
function activate(ctx: Context, config: Config): void {
  registerSearchModels(ctx, config)
  config = {
    ...config,
    exaApiKey: optionalString(config.exaApiKey),
    exaBaseUrl: optionalString(config.exaBaseUrl),
    kagiApiKey: optionalString(config.kagiApiKey),
    kagiBaseUrl: optionalString(config.kagiBaseUrl),
    openaiApiKey: optionalString(config.openaiApiKey),
    openaiBaseUrl: optionalString(config.openaiBaseUrl),
    openrouterApiKey: optionalString(config.openrouterApiKey),
    openrouterBaseUrl: optionalString(config.openrouterBaseUrl),
  }

  if (config.kagiEnabled === true && (config.kagiApiKey ?? process.env.KAGI_API_KEY)?.trim())
    ctx.web.registerSearchProvider(
      new KagiSearchProvider({
        apiKey: config.kagiApiKey ?? process.env.KAGI_API_KEY ?? '',
        baseURL: config.kagiBaseUrl ?? KAGI_DEFAULT_BASE_URL,
        ...(config.kagiLimit !== undefined ? { limit: config.kagiLimit } : {}),
      }),
    )
  if (
    config.openrouterEnabled === true &&
    (config.openrouterApiKey ?? process.env.OPENROUTER_API_KEY)?.trim()
  )
    ctx.web.registerSearchProvider(
      new OpenRouterSearchProvider({
        apiKey: config.openrouterApiKey ?? process.env.OPENROUTER_API_KEY ?? '',
        baseURL: config.openrouterBaseUrl ?? OPENROUTER_DEFAULT_BASE_URL,
        model: config.openrouterModel ?? OPENROUTER_DEFAULT_MODEL,
      }),
    )
  if (config.exaEnabled !== false)
    ctx.web.registerSearchProvider(
      new ExaSearchProvider({
        apiKey: config.exaApiKey ?? process.env.EXA_API_KEY ?? '',
        baseURL: config.exaBaseUrl ?? 'https://api.exa.ai',
      }),
    )
  if (config.openaiEnabled === true && (config.openaiApiKey ?? process.env.OPENAI_API_KEY)?.trim())
    ctx.web.registerSearchProvider(
      new OpenAIResponsesSearchProvider({
        mode: 'api',
        model: config.openaiModel,
        timeoutMs: config.searchTimeoutMs,
        apiKey: () => config.openaiApiKey ?? process.env.OPENAI_API_KEY,
        ...(config.openaiBaseUrl
          ? { apiKeyEndpoint: `${config.openaiBaseUrl.replace(/\/$/, '')}/responses` }
          : {}),
        codexCredentials: async () => undefined,
      }),
    )
  if (config.codexEnabled === true)
    ctx.web.registerSearchProvider(
      new OpenAIResponsesSearchProvider({
        mode: 'codex',
        accountAvailable: () => Boolean(ctx.get('codexSubscription')?.account()),
        model: config.codexModel,
        timeoutMs: config.searchTimeoutMs,
        apiKey: () => undefined,
        codexCredentials: (signal) =>
          ctx.get('codexSubscription')?.tokens(signal) ?? Promise.resolve(undefined),
      }),
    )
}

/** Complete configuration and managed capability lifetime. */
export const Config = editableConfig(BaseConfig)
export const apply = managedApply(BaseConfig, activate)
