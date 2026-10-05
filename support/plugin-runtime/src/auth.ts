import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { type AuthNamespace, type AuthView, authContribution, parseAuthView } from './auth-wire.ts'
import { parseSubscriptionQuota, type SubscriptionQuota } from './quota-wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    codexAuth: PluginAuthorization
    zaiAuth: PluginAuthorization
  }
}
interface Attempt {
  owner: string
  controller: AbortController
  view: NonNullable<AuthView['attempt']>
  pending?: { id: string; resolve: (value: string) => void; reject: (error: unknown) => void }
  done: Promise<void>
}
export interface AuthAccounts {
  list(): Promise<NonNullable<AuthView['accounts']>>
  select(name: string): Promise<void>
  remove(name: string): Promise<void>
  quota?(name: string, signal: AbortSignal): Promise<SubscriptionQuota>
  resetQuota?(
    name: string,
    resetId: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<SubscriptionQuota>
}

/** One provider-owned flow. Attempts belong to the admitted Peer that started them. */
export class PluginAuthorization extends TypertRemoteService {
  private attempt: Attempt | undefined
  private readonly lifetime = new AbortController()
  private quotaRequests = 0
  constructor(
    ctx: Context,
    private readonly key: CredentialKey,
    namespace: AuthNamespace,
    private readonly accounts?: AuthAccounts,
  ) {
    super(ctx, namespace)
    const contribution = authContribution(namespace)
    ctx.typert.register({
      package: contribution.package,
      face: 'host',
      model: { services: [], events: [], objects: [] },
      schemas: [],
      invocations: contribution.descriptors,
    })
    ctx.effect(
      () => async () => {
        this.lifetime.abort()
        this.attempt?.controller.abort()
        await this.attempt?.done
      },
      `${namespace}: stop authorization`,
    )
  }
  private owner(): string {
    const invocation = this.ctx.invocation
    if (!invocation) throw new Error('Authorization must run through the authenticated Gateway')
    return invocation.peer.id
  }
  async state(): Promise<AuthView> {
    const methods = this.ctx.authorization.list().find((row) => row.key === this.key)?.methods ?? []
    const attempt = this.attempt?.owner === this.owner() ? this.attempt.view : undefined
    return parseAuthView({
      methods,
      ...(attempt ? { attempt } : {}),
      ...(this.accounts ? { accounts: await this.accounts.list() } : {}),
    })
  }
  begin(method: string): Promise<AuthView> {
    const owner = this.owner()
    if (this.attempt?.view.status === 'running')
      throw new Error('A login attempt is already running. Finish or cancel it first.')
    if (
      !this.ctx.authorization
        .list()
        .find((row) => row.key === this.key)
        ?.methods.some((row) => row.id === method)
    )
      throw new Error('Unsupported login method')
    const controller = new AbortController()
    const attempt: Attempt = {
      owner,
      controller,
      view: { id: randomUUID(), status: 'running' },
      done: Promise.resolve(),
    }
    this.attempt = attempt
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000)])
    const stop = this.ctx.invocation!.peer.ctx.effect(
      () => () => controller.abort(),
      'plugin authorization: peer disconnected',
    )
    attempt.done = this.ctx.authorization
      .begin({
        key: this.key,
        method,
        signal,
        interaction: {
          notify: (notice) => {
            if (!signal.aborted) attempt.view.notice = notice
          },
          prompt: async (prompt: AuthorizationPrompt) => {
            if (attempt.pending) throw new Error('Overlapping authorization prompts')
            const id = randomUUID()
            const promptSignal = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal
            promptSignal.throwIfAborted()
            attempt.view.prompt = {
              id,
              kind: prompt.kind,
              message: prompt.message,
              ...(prompt.kind === 'select'
                ? { options: prompt.options.map(({ id, label }) => ({ id, label })) }
                : {}),
            }
            return new Promise<string>((resolve, reject) => {
              const abort = () => {
                attempt.pending?.reject(promptSignal.reason)
              }
              const cleanup = () => {
                promptSignal.removeEventListener('abort', abort)
                delete attempt.pending
                delete attempt.view.prompt
              }
              attempt.pending = {
                id,
                resolve: (value) => {
                  cleanup()
                  resolve(value)
                },
                reject: (error) => {
                  cleanup()
                  reject(error)
                },
              }
              promptSignal.addEventListener('abort', abort, { once: true })
              if (promptSignal.aborted) abort()
            })
          },
        },
      })
      .then(
        (outcome) => {
          attempt.view.status = outcome.status
        },
        () => {
          attempt.view.status = signal.aborted ? 'cancelled' : 'failed'
          // Provider error bodies can contain secrets. The UI receives only a generic failure.
          attempt.view.notice = {
            message: signal.aborted
              ? 'Login cancelled or expired.'
              : 'Login failed. Try again or choose another method.',
          }
        },
      )
      .finally(async () => {
        delete attempt.view.prompt
        delete attempt.pending
        await stop()
      })
    return this.state()
  }
  private owned(id: string): Attempt {
    const attempt = this.attempt
    if (!attempt || attempt.owner !== this.owner() || attempt.view.id !== id)
      throw new Error('Login attempt is unavailable')
    return attempt
  }
  answer(attemptId: string, promptId: string, value: string): Promise<AuthView> {
    const attempt = this.owned(attemptId)
    if (!attempt.pending || attempt.pending.id !== promptId || attempt.view.status !== 'running')
      throw new Error('Login prompt is no longer active')
    const options = attempt.view.prompt?.options
    if (options && !options.some((option) => option.id === value))
      throw new Error('Choose an offered option')
    attempt.pending.resolve(value)
    return this.state()
  }
  cancel(attemptId: string): Promise<AuthView> {
    this.owned(attemptId).controller.abort()
    return this.state()
  }
  async selectAccount(name: string): Promise<AuthView> {
    this.owner()
    if (!this.accounts) throw new Error('This provider does not support account selection')
    await this.accounts.select(name)
    return this.state()
  }
  async removeAccount(name: string): Promise<AuthView> {
    this.owner()
    if (!this.accounts) throw new Error('This provider does not support account removal')
    this.attempt?.controller.abort()
    await this.attempt?.done
    await this.accounts.remove(name)
    return this.state()
  }
  private async subscription<T>(
    name: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.owner()
    if (!this.accounts || !(await this.accounts.list()).some((account) => account.name === name))
      throw new Error('The account is no longer stored')
    if (this.quotaRequests >= 4) throw new Error('Subscription checks are busy. Try again shortly.')
    this.quotaRequests++
    const controller = new AbortController()
    const stop = this.ctx.invocation!.peer.ctx.effect(
      () => () => controller.abort(),
      'subscription: peer disconnected',
    )
    try {
      const result = await operation(
        AbortSignal.any([controller.signal, this.lifetime.signal, AbortSignal.timeout(20000)]),
      )
      if (!(await this.accounts.list()).some((account) => account.name === name))
        throw new Error('The account was removed during subscription check')
      return result
    } finally {
      this.quotaRequests--
      await stop()
    }
  }
  quota(name: string): Promise<SubscriptionQuota> {
    return this.subscription(name, async (signal) => {
      if (!this.accounts?.quota) throw new Error('Subscription quota is unavailable')
      return parseSubscriptionQuota(await this.accounts.quota(name, signal))
    })
  }
  resetQuota(name: string, resetId: string, requestId: string): Promise<SubscriptionQuota> {
    if (!/^[a-f0-9-]{36}$/i.test(requestId) || !resetId || resetId.length > 256)
      throw new Error('Invalid subscription reset request')
    return this.subscription(name, async (signal) => {
      if (!this.accounts?.resetQuota) throw new Error('No subscription reset is available')
      return parseSubscriptionQuota(
        await this.accounts.resetQuota(name, resetId, requestId, signal),
      )
    })
  }
}

export function registerAuthorization(
  ctx: Context,
  key: CredentialKey,
  namespace: AuthNamespace,
  accounts?: AuthAccounts,
): void {
  ctx.inject(['authorization', 'typert'], (scope) => {
    new PluginAuthorization(scope, key, namespace, accounts)
  })
}
