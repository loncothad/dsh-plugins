/** Named subscription accounts and selection share one atomically committed host grant. */
import { symbols } from '@deepseek-ai/cordis'
import {
  type CredentialKey,
  type CredentialProvider,
  type CredentialRecord,
  credentialKey,
} from '@deepseek-ai/dsh-credentials'
export const ZAI_STORE_SCOPE = 'zai'
export const ZAI_SUBSCRIPTION_KEY = credentialKey(ZAI_STORE_SCOPE, 'subscription') as CredentialKey
export interface ZaiSubscription {
  readonly kind: 'zai-subscription-v1'
  readonly name: string
  readonly apiKey: string
  readonly userName?: string
  readonly source: 'oauth' | 'api-key'
  readonly storedAt: number
  readonly oauthAccessToken?: string
  readonly oauthRefreshToken?: string
  readonly zcodeToken?: string
}
interface Pool {
  kind: 'zai-accounts-v1'
  accounts: ZaiSubscription[]
  active?: string
}
export interface ZaiStore {
  read(name?: string): Promise<ZaiSubscription | undefined>
  list(): Promise<readonly ZaiSubscription[]>
  active(): Promise<string | undefined>
  select(name: string): Promise<void>
  remove(name?: string): Promise<boolean>
  authorize(
    next: ZaiSubscription,
    commit: (record: CredentialRecord) => Promise<void>,
  ): Promise<void>
}
export function accountName(value: string): string {
  const name = value.trim().toLowerCase()
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name))
    throw new Error(
      'Use an account name beginning with a letter, then lowercase letters, digits or dashes',
    )
  return name
}
function pool(record: CredentialRecord | undefined): Pool {
  if (!record) return { kind: 'zai-accounts-v1', accounts: [] }
  const value = record.kind === 'grant' ? (record.payload as Partial<Pool>) : undefined
  if (
    value?.kind !== 'zai-accounts-v1' ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > 128 ||
    value.accounts.some(
      (row) =>
        row.kind !== 'zai-subscription-v1' ||
        accountName(row.name) !== row.name ||
        !row.apiKey ||
        !Number.isFinite(row.storedAt) ||
        !['oauth', 'api-key'].includes(row.source),
    ) ||
    new Set(value.accounts.map((row) => row.name)).size !== value.accounts.length ||
    (value.active !== undefined && !value.accounts.some((row) => row.name === value.active))
  )
    throw new Error('Invalid Z.AI account grant')
  return structuredClone(value as Pool)
}
const locks = new WeakMap<CredentialProvider, { tail: Promise<unknown> }>()
export function zaiStoreOf(credentials: CredentialProvider): ZaiStore {
  const original =
    (Reflect.get(credentials, symbols.original) as CredentialProvider | undefined) ?? credentials
  const lock = locks.get(original) ?? { tail: Promise.resolve() }
  locks.set(original, lock)
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = lock.tail.then(work, work)
    lock.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  const read = async () => pool(await credentials.readRecord(ZAI_SUBSCRIPTION_KEY))
  return {
    async read(name) {
      const current = await read()
      return current.accounts.find((row) => row.name === (name ?? current.active))
    },
    async list() {
      return (await read()).accounts
    },
    async active() {
      return (await read()).active
    },
    select(name) {
      return serialize(async () => {
        await credentials.modifyRecord(ZAI_SUBSCRIPTION_KEY, async (record) => {
          const current = pool(record)
          if (!current.accounts.some((row) => row.name === name))
            throw new Error('Unknown Z.AI account')
          return { kind: 'grant', payload: { ...current, active: name } }
        })
      })
    },
    remove(name) {
      return serialize(async () => {
        const current = await read(),
          target = name ?? current.active
        if (!current.accounts.some((row) => row.name === target)) return false
        const accounts = current.accounts.filter((row) => row.name !== target)
        if (!accounts.length) await credentials.deleteRecord(ZAI_SUBSCRIPTION_KEY)
        else
          await credentials.modifyRecord(ZAI_SUBSCRIPTION_KEY, async () => ({
            kind: 'grant',
            payload: {
              kind: 'zai-accounts-v1',
              accounts,
              ...(current.active !== target && current.active ? { active: current.active } : {}),
            },
          }))
        return true
      })
    },
    authorize(next, commit) {
      return serialize(async () => {
        const current = await read(),
          accounts = [...current.accounts.filter((row) => row.name !== next.name), next].sort(
            (a, b) => a.name.localeCompare(b.name),
          )
        const updated = pool({
          kind: 'grant',
          payload: { kind: 'zai-accounts-v1', accounts, active: next.name },
        })
        await commit({ kind: 'grant', payload: updated })
      })
    },
  }
}
