import {
  brokerFetch,
  credentialValue,
  editableConfig,
  managedApply,
  optionalString,
  registerAuthorization,
} from '@loncothad/dsh-plugin-runtime'
/**
 * Z.AI GLM coding-plan subscription providers for dsh: two provider routes
 * (`zai`, `zai-coding-cn`) over the OpenAI-compatible chat-completions
 * wire, plus subscription login — the OAuth browser flow and API-key mint
 * the reference clients use (zai-org/ZCode), or direct API-key entry
 * (earendil-works/pi style). The stored key serves every `zai` request.
 *
 * @module @loncothad/dsh-provider-zai
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'
import type { ZaiAuthInternals } from './auth.ts'
import { mintZaiApiKey, runZaiOAuthFlow } from './auth.ts'
import { createZaiProviders } from './provider.ts'
import type { ZaiStore } from './store.ts'
import { accountName, ZAI_SUBSCRIPTION_KEY, zaiStoreOf } from './store.ts'

export * from './auth.ts'
export * from './catalog.ts'
export type { ZaiProviderOptions } from './provider.ts'
export { createZaiProviders } from './provider.ts'
export * from './store.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'provider-zai'

/** The seams this plugin registers into. */
export const inject = ['llm', 'credentials', 'authorization', 'commands']

/** Plugin config. */
export interface Config {
  requestTimeoutMs?: number
  /** Z.AI key (fallback when no subscription is stored). Falls back to `$ZAI_API_KEY`. */
  apiKey?: string
  credentialSource?: 'account-or-key' | 'key' | 'broker'
  secretReference?: string
  brokerOrigins?: string[]
  /** Z.AI Coding CN key. Falls back to `$ZAI_CODING_CN_API_KEY`. */
  codingCnApiKey?: string
  /** Endpoint overrides for gateways. */
  endpoint?: string
  codingCnEndpoint?: string
}

const BaseConfig = z.object({
  requestTimeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .max(900000)
    .default(300000)
    .description('Chat deadline in milliseconds; replacing configuration cancels active requests.'),
  credentialSource: z
    .union(['account-or-key', 'key', 'broker'])
    .default('account-or-key')
    .description(
      'Account-or-key prefers the signed-in coding account, then this profile’s API key. Broker excludes both and uses only its scoped reference.',
    ),
  secretReference: z
    .string()
    .description('Secrets Broker reference ID authorized for the zai consumer.'),
  brokerOrigins: z
    .array(z.string())
    .default(['https://api.z.ai'])
    .description('Explicit HTTPS origins permitted to receive the broker credential.'),
  apiKey: z
    .string()
    .role('secret')
    .description(
      'Z.AI key (fallback when no subscription is stored); empty falls back to $ZAI_API_KEY.',
    ),
  codingCnApiKey: z
    .string()
    .role('secret')
    .description('Z.AI Coding CN key; empty falls back to $ZAI_CODING_CN_API_KEY.'),
  endpoint: z.string().description('Z.AI endpoint override.'),
  codingCnEndpoint: z.string().description('Z.AI Coding CN endpoint override.'),
})

/**
 * Register both routes and the login surface (flow + commands).
 * @param ctx - plugin context.
 * @param config - schema-resolved config.
 * @param internals - deterministic hooks for tests.
 */
function activate(ctx: Context, config: Config, internals: ZaiInternals = {}): void {
  config = {
    ...config,
    apiKey: optionalString(config.apiKey),
    codingCnApiKey: optionalString(config.codingCnApiKey),
    codingCnEndpoint: optionalString(config.codingCnEndpoint),
    endpoint: optionalString(config.endpoint),
  }

  const store: ZaiStore = zaiStoreOf(ctx.credentials)
  const reference = () =>
    config.credentialSource === 'broker' ? optionalString(config.secretReference) : undefined
  if (config.credentialSource === 'broker' && !reference())
    throw new Error('Choose a Z.AI broker secret reference')
  const transport = brokerFetch(ctx, {
    consumer: 'zai',
    reference,
    origins: config.brokerOrigins ?? ['https://api.z.ai'],
    scheme: 'Bearer',
  })
  const lifetime = new AbortController()
  ctx.effect(
    () => () => lifetime.abort(new Error('Z.AI provider disposed')),
    'zai: cancel active requests',
  )
  const { zai, codingCn } = createZaiProviders({
    lifetime: lifetime.signal,
    timeoutMs: config.requestTimeoutMs,
    fetch: transport,
    codingCnFetch: fetch,
    store: () =>
      config.credentialSource === 'key' || config.credentialSource === 'broker'
        ? Promise.resolve(undefined)
        : credentialValue(ctx, () => store.read()),
    apiKey: () =>
      credentialValue(ctx, () =>
        reference() ? 'broker-managed' : (config.apiKey ?? process.env.ZAI_API_KEY),
      ),
    codingCnApiKey: () =>
      credentialValue(ctx, () => config.codingCnApiKey ?? process.env.ZAI_CODING_CN_API_KEY),
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    ...(config.codingCnEndpoint !== undefined ? { codingCnEndpoint: config.codingCnEndpoint } : {}),
  })
  ctx.llm.registerAdapter(['zai'], zai)
  ctx.llm.registerAdapter(['zai-coding-cn'], codingCn)

  registerZaiLogin(ctx, store, internals)
}

/** Injected CLI authorization transport and clock for qualification. */
export type ZaiInternals = ZaiAuthInternals

/** The login flow and the /zai-* commands. */
export function registerZaiLogin(
  ctx: Context,
  store: ZaiStore,
  internals: ZaiInternals = {},
): void {
  registerAuthorization(ctx, ZAI_SUBSCRIPTION_KEY, 'zaiAuth', {
    ...zaiQuotaAccount(store, internals.fetch ?? fetch),
    async list() {
      const active = await store.active()
      return (await store.list()).map((value) => ({
        name: value.name,
        label: value.userName ? `${value.name} · ${value.userName}` : value.name,
        active: value.name === active,
      }))
    },
    async select(name) {
      await store.select(name)
    },
    async remove(name) {
      ctx.authorization.cancel(ZAI_SUBSCRIPTION_KEY)
      await store.remove(name)
    },
  })

  ctx.authorization.registerFlow({
    key: ZAI_SUBSCRIPTION_KEY,
    label: 'Z.AI subscription',
    methods: [
      { id: 'device', label: 'Sign in with Z.AI through ZCode' },
      { id: 'key', label: 'Paste an existing Z.AI coding-plan API key' },
    ],
    run: async (session: AuthorizationSession): Promise<void> => {
      const name = accountName(
        await session.prompt({
          kind: 'text',
          message: 'Name this Z.AI account (lowercase letters, digits, dashes):',
        }),
      )
      const transport = internals.fetch ?? fetch
      const flowInternals = {
        ...internals,
        signal: session.signal,
        notify: (notice: { message: string; url?: string }) => session.notify(notice),
        fetch: ((input, init) =>
          transport(input, {
            ...init,
            redirect: 'error',
            signal: AbortSignal.any([session.signal, AbortSignal.timeout(30_000)]),
          })) as typeof fetch,
      }
      if (session.method === 'key') {
        const pasted = await session.prompt({
          kind: 'secret',
          message: 'Paste the Z.AI coding-plan API key (id.secret):',
        })
        const apiKey = pasted.trim()
        if (apiKey.length === 0) throw new Error('the pasted Z.AI API key is empty')
        await store.authorize(
          { kind: 'zai-subscription-v1', name, apiKey, source: 'api-key', storedAt: Date.now() },
          (record) => session.commit(record),
        )
        return
      }
      if (session.method !== 'device') throw new Error('Unsupported Z.AI login method')
      const ready = await runZaiOAuthFlow(flowInternals)
      const apiKey = await mintZaiApiKey(ready.accessToken, flowInternals)
      session.signal.throwIfAborted()
      await store.authorize(
        {
          kind: 'zai-subscription-v1',
          name,
          apiKey,
          oauthAccessToken: ready.accessToken,
          ...(ready.refreshToken ? { oauthRefreshToken: ready.refreshToken } : {}),
          ...(ready.zcodeToken ? { zcodeToken: ready.zcodeToken } : {}),
          ...(ready.userName !== undefined ? { userName: ready.userName } : {}),
          source: 'oauth',
          storedAt: Date.now(),
        },
        (record) => session.commit(record),
      )
    },
  })

  ctx.commands.register({
    name: 'zai-status',
    description: 'Show the stored Z.AI subscription',
    handler: async (): Promise<CommandResult> => {
      const subscription = await store.read()
      if (subscription === undefined) {
        return {
          kind: 'success',
          text: 'No Z.AI subscription is stored; open Plugins → Z.AI → Subscription login.',
        }
      }
      return {
        kind: 'success',
        text:
          `Z.AI subscription: ${subscription.source === 'oauth' ? 'OAuth' : 'API key'}` +
          `${subscription.userName !== undefined ? ` (${subscription.userName})` : ''}`,
      }
    },
  })

  ctx.commands.register({
    name: 'zai-logout',
    description: 'Remove the stored Z.AI subscription',
    handler: async (): Promise<CommandResult> => {
      ctx.authorization.cancel(ZAI_SUBSCRIPTION_KEY)
      const removed = await store.remove()
      return removed
        ? { kind: 'success', text: 'Removed the stored Z.AI subscription.' }
        : { kind: 'error', text: 'No Z.AI subscription is stored.' }
    },
  })
}

/** Complete configuration and managed capability lifetime. */
export const Config = editableConfig(BaseConfig)
export const apply = managedApply(BaseConfig, activate)

import { zaiQuotaAccount } from './quota.ts'
