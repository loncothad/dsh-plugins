/** Shared, validated contracts for plugin-owned authorization through the authenticated DSH Gateway. */
import type {
  RemoteResult,
  TypertCodec,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import { parseSubscriptionQuota, type SubscriptionQuota } from './quota-wire.ts'

export type AuthNamespace = 'codexAuth' | 'zaiAuth'
export interface AuthPrompt {
  id: string
  kind: 'text' | 'secret' | 'select'
  message: string
  options?: { id: string; label: string }[]
}
export interface AuthView {
  methods: { id: string; label: string }[]
  accounts?: { name: string; label: string; active: boolean }[]
  attempt?: {
    id: string
    status: 'running' | 'authorized' | 'cancelled' | 'failed'
    notice?: { message: string; url?: string; code?: string }
    prompt?: AuthPrompt
  }
}
export interface AuthRemote {
  state(): Promise<RemoteResult<AuthView>>
  begin(method: string): Promise<RemoteResult<AuthView>>
  answer(attemptId: string, promptId: string, value: string): Promise<RemoteResult<AuthView>>
  cancel(attemptId: string): Promise<RemoteResult<AuthView>>
  selectAccount(name: string): Promise<RemoteResult<AuthView>>
  removeAccount(name: string): Promise<RemoteResult<AuthView>>
  quota(name: string): Promise<RemoteResult<SubscriptionQuota>>
  resetQuota(
    name: string,
    resetId: string,
    requestId: string,
  ): Promise<RemoteResult<SubscriptionQuota>>
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    codexAuth: AuthRemote
    zaiAuth: AuthRemote
  }
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid authorization response')
  return value as Record<string, unknown>
}
const string = (value: unknown, max = 4096): string => {
  if (typeof value !== 'string' || value.length > max)
    throw new TypeError('Invalid authorization text')
  return value
}
const codec = (symbol: string, parse: (value: unknown) => unknown): TypertCodec => ({
  mode: 'strict',
  typeSymbol: `@loncothad/dsh-plugin-runtime/auth#${symbol}`,
  create: () => ({ parse }),
})
export function parseAuthView(value: unknown): AuthView {
  const row = object(value)
  if (!Array.isArray(row.methods) || row.methods.length > 8)
    throw new TypeError('Invalid authorization methods')
  const methods = row.methods.map((value) => {
    const method = object(value)
    return { id: string(method.id, 64), label: string(method.label) }
  })
  let accounts: AuthView['accounts']
  if (row.accounts !== undefined) {
    if (!Array.isArray(row.accounts) || row.accounts.length > 128)
      throw new TypeError('Invalid account list')
    accounts = row.accounts.map((value) => {
      const account = object(value)
      if (typeof account.active !== 'boolean') throw new TypeError('Invalid active account')
      return {
        name: string(account.name, 256),
        label: string(account.label, 512),
        active: account.active,
      }
    })
  }
  if (row.attempt === undefined) return { methods, ...(accounts ? { accounts } : {}) }
  const attempt = object(row.attempt)
  const status = attempt.status
  if (
    status !== 'running' &&
    status !== 'authorized' &&
    status !== 'cancelled' &&
    status !== 'failed'
  )
    throw new TypeError('Invalid authorization status')
  const result: AuthView = {
    methods,
    ...(accounts ? { accounts } : {}),
    attempt: { id: string(attempt.id, 64), status },
  }
  if (attempt.notice !== undefined) {
    const notice = object(attempt.notice)
    const url = notice.url === undefined ? undefined : new URL(string(notice.url))
    if (url?.username || url?.password)
      throw new TypeError('Authorization links cannot contain credentials')
    if (
      url &&
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new TypeError('Invalid authorization link')
    result.attempt!.notice = {
      message: string(notice.message),
      ...(url ? { url: url.href } : {}),
      ...(notice.code !== undefined ? { code: string(notice.code, 128) } : {}),
    }
  }
  if (attempt.prompt !== undefined) {
    const prompt = object(attempt.prompt)
    if (prompt.kind !== 'text' && prompt.kind !== 'secret' && prompt.kind !== 'select')
      throw new TypeError('Invalid authorization prompt')
    const options = prompt.options
    if (options !== undefined && (!Array.isArray(options) || options.length > 128))
      throw new TypeError('Invalid authorization options')
    result.attempt!.prompt = {
      id: string(prompt.id, 64),
      kind: prompt.kind,
      message: string(prompt.message),
      ...(Array.isArray(options)
        ? {
            options: options.map((value) => {
              const option = object(value)
              return { id: string(option.id), label: string(option.label) }
            }),
          }
        : {}),
    }
  }
  return result
}

/** Host and Client register exactly the same strict descriptors; no ambient source reflection is required. */
export function authContribution(namespace: AuthNamespace): TypertRemoteContribution {
  const arg = codec('string', (value) => string(value))
  return {
    package: `@loncothad/dsh-plugin-runtime.${namespace}`,
    descriptors: Object.entries({
      state: [],
      begin: ['method'],
      answer: ['attemptId', 'promptId', 'value'],
      cancel: ['attemptId'],
      selectAccount: ['name'],
      removeAccount: ['name'],
      quota: ['name'],
      resetQuota: ['name', 'resetId', 'requestId'],
    }).map(([method, parameters]) => ({
      id: `${namespace}/${method}`,
      namespace,
      service: namespace,
      method,
      invocation: { kind: 'direct' as const },
      parameters: parameters.map((name) => ({
        name,
        wire: name,
        source: 'json' as const,
        codec: arg,
      })),
      result:
        method === 'quota' || method === 'resetQuota'
          ? codec('SubscriptionQuota', parseSubscriptionQuota)
          : codec('AuthView', parseAuthView),
    })),
  }
}
