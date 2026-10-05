import { registerCodexUsage } from './usage.ts'

export * from './usage.ts'

import {
  configEntry,
  credentialStore,
  editableConfig,
  getPiUserAgent,
  managedApply,
  optionalString,
  registerAuthorization,
} from '@loncothad/dsh-plugin-runtime'

/**
 * OpenAI Codex subscription provider for dsh: one substrate — a signed-in
 * ChatGPT Codex account — serving three assemblies. The `codex` provider
 * route over the Responses wire with live model discovery; the Daybreak
 * chat route with its fast-mode tier; and subscription image generation
 * (the `codex_image_generate` tool, `/codex-image`, and the runtime
 * skill). OAuth login (browser PKCE or device), the multiaccount store,
 * and the `/codex-*` commands round out the account surface. dsh has no
 * Codex OAuth support of its own; this plugin fills that gap.
 *
 * @module @loncothad/dsh-provider-openai-codex
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'
import { CodexAdapter } from './adapter.ts'
import { deviceLogin } from './device.ts'
import { isDaybreakProgram } from './discovery.ts'
import type { CodexImageOptions } from './image-register.ts'
import { imageToolOptions, registerCodexImage } from './image-register.ts'
import { registerCodexModelCommands } from './model-commands.ts'
import {
  accountPayloadFrom,
  authorizeUrl,
  CALLBACK_PORTS,
  makePkce,
  normalizeAccountName,
  OAUTH_TOKEN_ENDPOINT,
  type PkceMaterial,
  parseTokenResponse,
  tokenRequestBody,
} from './oauth.ts'
import { codexQuotaAccount } from './quota.ts'
import type { SpeedAccess, SpeedName } from './speed.ts'
import { normalizeSpeed, SPEED_TIERS } from './speed.ts'
import type { CodexAuthorizationStore } from './store.ts'
import { ACCOUNT_POOL_KEY, accountStoreOf } from './store.ts'

export { CodexAdapter, quotaExhausted } from './adapter.ts'
export * from './device.ts'
export * from './discovery.ts'
export * from './executor.ts'
export * from './image.ts'
export { type CodexImageOptions, imageToolOptions, registerCodexImage } from './image-register.ts'
export {
  CODEX_PROVIDERS,
  type CodexModelCommandsOptions,
  registerCodexModelCommands,
} from './model-commands.ts'
export * from './oauth.ts'
export * from './skill.ts'
export * from './speed.ts'
export * from './store.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'provider-openai-codex'

/** The seams this plugin registers into. */
export const inject = ['llm', 'credentials', 'authorization', 'commands', 'tools', 'skills']

/** Plugin config. */
export interface Config {
  requestTimeoutMs?: number
  /** Responses endpoint override for the Codex backend (chat + image). */
  endpoint?: string
  catalogProtocolVersion?: string
  /**
   * Processing speed layered onto every codex request: `standard`,
   * `fast` (the backend's `priority` tier), or `ultrafast`. Models that
   * do not advertise a tier ignore it.
   */
  speed: Volatile<string>
  /**
   * The Daybreak cyber access program the `codex-daybreak` route sends on
   * every request (`daybreak_blue` default, `daybreak_red` for the
   * highest tier). Verification and authorization stay server-owned.
   */
  daybreakProgram?: 'daybreak_blue' | 'daybreak_red'
  /** Switch to another stored account when this one's quota is exhausted (default true). */
  accountFallback?: boolean
  /** Comma-separated account names never fallen back to. */
  accountFallbackExclude?: string
  /** Model id for image-generation requests. */
  usageTrackingEnabled?: boolean
  usageCodes?: string[]
  imageModel?: string
  imageEndpoint?: string
  imageQuality?: 'auto' | 'low' | 'medium' | 'high'
  imageSize?: string
  imageBackground?: string
  imageTimeoutMs?: number
  imageMaxOutputBytes?: number
  imageTools?: boolean
  imageSkills?: boolean
  imageCommands?: boolean
  /** Where generated images are written (default `codex-images/`). */
  imageOutDir?: string
}

const BaseConfig = z.object({
  usageTrackingEnabled: z
    .boolean()
    .default(true)
    .description(
      'Record local Codex rate-limit observations. /codex-usage shows them; /codex-usage reset confirm clears them. Server quotas are unchanged.',
    ),
  usageCodes: z
    .array(z.string())
    .default(['RATE_LIMIT'])
    .description('Failure codes recorded as local Codex usage observations.'),
  requestTimeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .max(900000)
    .default(300000)
    .description(
      'Chat request deadline in milliseconds; configuration replacement cancels active requests.',
    ),
  endpoint: z.string().description('Codex Responses endpoint override for chat.'),
  catalogProtocolVersion: z
    .string()
    .pattern(/^\d+\.\d+\.\d+$/)
    .default('0.160.0')
    .description(
      'Qualified Codex catalog protocol version. The backend filters models by this version; it is independent of the plugin release version. Change only after validating a newer contract.',
    ),
  speed: z
    .union(['standard', 'fast', 'ultrafast'])
    .default('standard')
    .volatile()
    .description(
      'Processing speed layered onto every request: standard, fast (priority tier), or ultrafast; models without the tier keep standard routing.',
    ),
  daybreakProgram: z
    .string()
    .description(
      'The cyber access program the Daybreak route sends: daybreak_blue (default) or daybreak_red. Verification stays server-owned.',
    ),
  accountFallback: z
    .boolean()
    .default(true)
    .description(
      'Switch to another stored account when this one\u2019s quota is exhausted (usage-limit 429s).',
    ),
  accountFallbackExclude: z
    .string()
    .description('Comma-separated account names never fallen back to.'),
  imageModel: z
    .string()
    .default('gpt-image-2')
    .description(
      'Native Images model ID; gpt-image-2 is the current Codex CLI image model. Account access is enforced by the provider.',
    ),
  imageEndpoint: z
    .string()
    .description(
      'Native Images generation endpoint override; use a dedicated gateway URL when chat has an override.',
    ),
  imageQuality: z
    .union(['auto', 'low', 'medium', 'high'])
    .default('auto')
    .description('Default image quality.'),
  imageSize: z
    .union(['auto', '1024x1024', '1536x1024', '1024x1536'])
    .default('auto')
    .description('Default image dimensions.'),
  imageBackground: z
    .union(['auto', 'transparent', 'opaque'])
    .default('auto')
    .description('Default background treatment.'),
  imageTimeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .max(900000)
    .default(180000)
    .description('Image generation deadline in milliseconds.'),
  imageMaxOutputBytes: z
    .number()
    .step(1)
    .min(1024)
    .max(67108864)
    .default(67108864)
    .description('Maximum image response and published file bytes.'),
  imageTools: z
    .boolean()
    .default(true)
    .description(
      'Enable the native image-generation tool; disabled tools cannot execute directly.',
    ),
  imageSkills: z.boolean().default(true).description('Enable the image-generation skill.'),
  imageCommands: z.boolean().default(true).description('Enable the /codex-image command.'),
  imageOutDir: z
    .string()
    .description('Directory generated images are written to (default codex-images).'),
})

/** Parse the comma-separated account-exclusion list. */
function parseExclude(value: string | undefined): readonly string[] {
  return (value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
}

/** Deterministic hooks for tests. */
export interface CodexInternals {
  random?: () => number
  sha256?: (input: string) => Promise<string>
  fetch?: typeof fetch
  now?: () => number
  openBrowser?: (url: string) => Promise<void>
  /** Replaces the localhost-callback listener in tests. */
  listen?: (ports: readonly number[]) => Promise<CallbackListener>
}

/** One running localhost callback listener. */
export interface CallbackListener {
  readonly port: number
  /** Resolves with the callback query when the browser lands. */
  readonly callback: Promise<{ code?: string; state?: string }>
  close(): void
}

/**
 * Wire the provider routes (standard + Daybreak), the authorization flow,
 * the speed layer, and the commands. The flow key is shared
 * (`openai-codex/accounts`); the account name is the first prompt, and one
 * login surface runs at a time per that key.
 */
export function registerCodex(
  ctx: Context,
  config: {
    requestTimeoutMs?: number
    /** Responses endpoint override. */
    endpoint?: string
    catalogProtocolVersion?: string
    /** Speed-layer selection; the adapter filters tiers per model. */
    speed?: SpeedAccess
    /** Cyber access program the Daybreak route sends (default `daybreak_blue`). */
    daybreakProgram?: 'daybreak_blue' | 'daybreak_red'
    /** Switch to another stored account on quota exhaustion (default true). */
    accountFallback?: boolean
    /** Comma-separated account names never fallen back to. */
    accountFallbackExclude?: string
  },
  internals: CodexInternals = {},
): CodexAdapter {
  const lifetime = new AbortController()
  ctx.effect(
    () => () => lifetime.abort(new Error('Codex provider disposed')),
    'codex: cancel active requests',
  )
  const store: CodexAuthorizationStore = accountStoreOf(ctx.credentials)
  const scopedStore = credentialStore(ctx, store)
  const fetchImpl = internals.fetch ?? fetch
  const now = internals.now ?? Date.now
  const listen = internals.listen ?? defaultListen
  // Account fallback on quota exhaustion: shared by both routes.
  const accountFallback = {
    enabled: () => config.accountFallback ?? true,
    exclude: () => parseExclude(config.accountFallbackExclude),
  }

  const adapter = new CodexAdapter({
    lifetime: lifetime.signal,
    timeoutMs: config.requestTimeoutMs,
    catalogProtocolVersion: config.catalogProtocolVersion,
    store: scopedStore,
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    ...(config.speed !== undefined
      ? { serviceTier: () => SPEED_TIERS[config.speed!.speed()] }
      : {}),
    accountFallback,
    fetch: fetchImpl,
    now,
  })
  ctx.llm.registerAdapter(['codex'], adapter)
  ctx.provide('codexSubscription', {
    tokens: (signal?: AbortSignal) => adapter.activeTokens(signal),
    account: () => store.active(),
  })

  // The Daybreak toggle: a second provider route in the same model
  // window. Its catalog lists only the models that advertise a Daybreak
  // cyber access program, and every request carries
  // `access_programs: { cyber }` — the verification-gated programs for
  // security work. Authorization stays server-owned; picking this group
  // with an unverified account fails at inference, exactly like the
  // official client.
  const program = config.daybreakProgram ?? 'daybreak_blue'
  if (program !== 'daybreak_blue' && program !== 'daybreak_red') {
    throw new Error(
      `daybreakProgram must be "daybreak_blue" or "daybreak_red", got ${JSON.stringify(program)}`,
    )
  }
  const daybreak = new CodexAdapter({
    lifetime: lifetime.signal,
    timeoutMs: config.requestTimeoutMs,
    catalogProtocolVersion: config.catalogProtocolVersion,
    store: scopedStore,
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    ...(config.speed !== undefined
      ? { serviceTier: () => SPEED_TIERS[config.speed!.speed()] }
      : {}),
    accessProgram: program,
    providerName: `ChatGPT Codex Daybreak (subscription, ${program})`,
    modelFilter: (model) => model.cyberPrograms?.some((value) => isDaybreakProgram(value)) === true,
    accountFallback,
    fetch: fetchImpl,
    now,
  })
  ctx.llm.registerAdapter(['codex-daybreak'], daybreak)

  // The harness's model-discovery seam (Settings -> Models interrogation):
  // the signed-in account's backend answers; signed-out routes advertise no models.
  ctx.llm.registerModelDiscovery('openai-codex', async () => {
    const catalog = await adapter.catalog()
    return catalog.models.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    }))
  })

  const exchange = async (body: URLSearchParams, signal: AbortSignal) => {
    const response = await fetchImpl(OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'user-agent': getPiUserAgent(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })
    const payload: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new Error(`the OAuth token exchange failed (HTTP ${response.status})`)
    }
    return parseTokenResponse(payload)
  }

  const sha256 =
    internals.sha256 ?? (async (input) => createHash('sha256').update(input).digest('base64url'))

  registerAuthorization(ctx, ACCOUNT_POOL_KEY, 'codexAuth', {
    ...codexQuotaAccount(adapter, store, fetchImpl),
    async list() {
      const active = await store.active()
      return Promise.all(
        (await store.list()).map(async (name) => {
          const account = await store.read(name)
          return {
            name,
            label: account?.planType ? `${name} · ${account.planType}` : name,
            active: name === active,
          }
        }),
      )
    },
    async select(name) {
      await store.setActive(name)
    },
    async remove(name) {
      ctx.authorization.cancel(ACCOUNT_POOL_KEY)
      if (!(await store.remove(name))) throw new Error('The account is no longer stored')
    },
  })

  ctx.authorization.registerFlow({
    key: ACCOUNT_POOL_KEY,
    label: 'ChatGPT Codex account',
    methods: [
      { id: 'browser', label: 'Open the browser and wait on a localhost callback' },
      { id: 'device', label: 'Enter a code at the provider device page' },
    ],
    run: async (session: AuthorizationSession): Promise<void> => {
      const accountName = normalizeAccountName(
        await session.prompt({
          kind: 'text',
          message: 'Name this Codex account (lowercase letters, digits, dashes):',
        }),
      )
      if (session.method === 'device') {
        const tokens = await deviceLogin({
          signal: session.signal,
          notify: (notice) => session.notify(notice),
          fetch: fetchImpl,
        })
        await commitAccount(store, session, accountName, tokens)
        return
      }
      const material: PkceMaterial = await makePkce(
        internals.random ?? (() => randomBytes(1)[0]! / 256),
        sha256,
      )
      const signal = AbortSignal.any([session.signal, AbortSignal.timeout(15 * 60_000)])
      const listener = await listen(CALLBACK_PORTS)
      try {
        const url = authorizeUrl(material, listener.port)
        session.notify({ message: `Complete the Codex login in the browser:\n${url}`, url })
        await internals.openBrowser?.(url)
        const query = await waitForCallback(listener.callback, signal)
        if (query.state !== material.state) {
          throw new Error('the OAuth callback state did not match this login')
        }
        if (query.code === undefined) {
          throw new Error('the OAuth callback omitted its authorization code')
        }
        const tokens = await exchange(tokenRequestBody(material, query.code, listener.port), signal)
        await commitAccount(store, session, accountName, tokens)
      } finally {
        listener.close()
      }
    },
  })

  ctx.commands.register({
    name: 'codex-accounts',
    description: 'List stored Codex accounts',
    handler: async (): Promise<CommandResult> => {
      const names = await store.list()
      const active = await store.active()
      if (names.length === 0) {
        return {
          kind: 'success',
          text: 'No Codex accounts are stored. Open Plugins → ChatGPT Codex → Subscription login to add one.',
        }
      }
      return {
        kind: 'success',
        text: names.map((name) => `${name === active ? '* ' : '  '}${name}`).join('\n'),
      }
    },
  })

  ctx.commands.register({
    name: 'codex-use',
    description: 'Switch the active Codex account',
    input: { hint: '[NAME]' },
    handler: async (invocation): Promise<CommandResult> => {
      const name = invocation.rawInput.trim()
      if (name.length === 0) {
        const active = await store.active()
        return {
          kind: 'success',
          text:
            active !== undefined
              ? `The active Codex account is ${active}.`
              : 'No Codex account is active.',
        }
      }
      if ((await store.read(name)) === undefined) {
        return {
          kind: 'error',
          text: `No stored Codex account named ${name}; run /codex-accounts.`,
        }
      }
      await store.setActive(name)
      return { kind: 'success', text: `The active Codex account is now ${name}.` }
    },
  })

  ctx.commands.register({
    name: 'codex-logout',
    description: 'Remove a stored Codex account',
    input: { hint: 'NAME' },
    handler: async (invocation): Promise<CommandResult> => {
      const name = invocation.rawInput.trim()
      if (name.length === 0) return { kind: 'error', text: 'Usage: /codex-logout NAME.' }
      ctx.authorization.cancel(ACCOUNT_POOL_KEY)
      const removed = await store.remove(name)
      return removed
        ? { kind: 'success', text: `Removed the Codex account ${name}.` }
        : { kind: 'error', text: `No stored Codex account named ${name}.` }
    },
  })

  ctx.commands.register({
    name: 'codex-status',
    description: 'Show the active Codex account and its plan',
    handler: async (): Promise<CommandResult> => {
      const name = await store.active()
      if (name === undefined) {
        return {
          kind: 'success',
          text: 'No Codex account is active; open Plugins → ChatGPT Codex → Subscription login.',
        }
      }
      const account = await store.read(name)
      return {
        kind: 'success',
        text:
          `Active Codex account: ${name}\n` +
          `Plan: ${account?.planType ?? 'unknown'}\n` +
          `Account id: ${account?.accountId?.slice(0, 8) ?? 'unknown'}\n` +
          `Token refresh: ${account?.tokens.refreshToken !== undefined ? 'enabled' : 'unavailable'}`,
      }
    },
  })

  // The model-behavior commands (/codex-speed, /daybreak, /codex-image)
  // mount separately through registerCodexModelCommands — only while the
  // default selection points at this provider. The account commands above
  // stay unconditional: subscription login must precede any Codex model choice.
  return adapter
}

/**
 * Persist one token response as a named account and make it active. The
 * flow commits the real account pool and active selection atomically.
 */
async function commitAccount(
  store: CodexAuthorizationStore,
  session: AuthorizationSession,
  name: string,
  tokens: ReturnType<typeof parseTokenResponse>,
): Promise<void> {
  const payload = accountPayloadFrom(name, tokens, undefined, Date.now())
  await store.authorize(payload, (record) => session.commit(record))
}

/** Wait for a callback while releasing the cancellation listener on settlement. */
async function waitForCallback<T>(callback: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => {
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    callback.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

/** Start one localhost callback listener on the first open port. */
async function defaultListen(ports: readonly number[]): Promise<CallbackListener> {
  const errors: unknown[] = []
  for (const port of ports) {
    const { promise: callback, resolve: settle } = Promise.withResolvers<{
      code?: string
      state?: string
    }>()
    let server: ReturnType<typeof createServer>
    try {
      server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', `http://localhost:${port}`)
        if (request.method !== 'GET' || url.pathname !== '/auth/callback') {
          response.writeHead(404)
          response.end('Not found')
          return
        }
        if (
          !url.searchParams.has('state') ||
          (!url.searchParams.has('code') && !url.searchParams.has('error'))
        ) {
          response.writeHead(400)
          response.end('Invalid authorization callback')
          return
        }
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('Authorization received; check DeepSeek Harness for the result.')
        settle({
          ...(url.searchParams.has('code')
            ? { code: url.searchParams.get('code') ?? undefined }
            : {}),
          ...(url.searchParams.has('state')
            ? { state: url.searchParams.get('state') ?? undefined }
            : {}),
        })
      })
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject)
        server!.listen(port, '127.0.0.1', () => resolve())
      })
    } catch (error: unknown) {
      errors.push(error)
      continue
    }
    return {
      port,
      callback,
      close: () => {
        server!.close()
      },
    }
  }
  throw new Error(
    `could not start the OAuth callback server on ports ${ports.join(', ')}: ${String(errors[0])}`,
  )
}

/**
 * Register with schema-resolved config, composing all three assemblies
 * over the shared account substrate: the account surface (route, auth
 * flow, account commands) unconditionally; the model-behavior commands
 * only while the default selection points at this provider.
 */
function activate(ctx: Context, config: Config, internals: CodexInternals = {}): void {
  if (config.usageTrackingEnabled !== false) registerCodexUsage(ctx, config.usageCodes)
  config = { ...config, endpoint: optionalString(config.endpoint) }

  const speed: SpeedAccess = {
    speed: () => normalizeSpeed(config.speed?.get()),
    setSpeed: (next) => persistSpeed(ctx, next),
  }
  const adapter = registerCodex(
    ctx,
    {
      requestTimeoutMs: config.requestTimeoutMs,
      catalogProtocolVersion: config.catalogProtocolVersion,
      ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
      ...(config.daybreakProgram !== undefined ? { daybreakProgram: config.daybreakProgram } : {}),
      ...(config.accountFallback !== undefined ? { accountFallback: config.accountFallback } : {}),
      ...(config.accountFallbackExclude !== undefined
        ? { accountFallbackExclude: config.accountFallbackExclude }
        : {}),
      speed,
    },
    internals,
  )

  const image: CodexImageOptions = {
    endpoint:
      optionalString(config.imageEndpoint) ??
      'https://chatgpt.com/backend-api/codex/images/generations',
    model: optionalString(config.imageModel) ?? 'gpt-image-2',
    quality: config.imageQuality,
    size: config.imageSize,
    background: config.imageBackground,
    timeoutMs: config.imageTimeoutMs,
    maxResponseBytes: config.imageMaxOutputBytes,
    outDir: config.imageOutDir ?? 'codex-images',
    tokens: (signal) => adapter.activeTokens(signal),
  }
  // The tool and skill are model-callable capabilities: any active model
  // may spend the codex subscription for image generation, so they stay
  // globally registered. The /codex-image command is model-behavior UX.
  registerCodexImage(ctx, image, {
    tools: config.imageTools,
    skills: config.imageSkills && config.imageTools !== false,
  })
  registerCodexModelCommands(ctx, {
    speed,
    ...(config.imageCommands !== false ? { image: imageToolOptions(image, ctx) } : {}),
  })
}

/**
 * Persist a speed change through the config editor so it survives
 * restarts. The edit callback returns the whole entry config — every
 * section's current values with `speed` replaced — because the editor
 * replaces, not merges.
 */
function persistSpeed(ctx: Context, next: SpeedName): void {
  const entry = configEntry(ctx)
  const editor = ctx.get('configEditor')
  if (entry === undefined || editor === undefined) {
    ctx.logger.warn(
      'codex-speed: no configuration editor mounted; the speed change applies to this process only',
    )
    return
  }
  editor
    .edit(entry, (current) => ({ ...current, speed: next }))
    .catch((error) => {
      ctx.logger.warn('codex-speed: persisting the speed change failed')
      ctx.logger.warn(error)
    })
}

/** Complete configuration and managed capability lifetime. */
export const Config = editableConfig(BaseConfig)
export const apply = managedApply(BaseConfig, activate)
