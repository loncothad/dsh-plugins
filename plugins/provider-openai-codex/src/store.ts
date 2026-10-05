/** One atomic credential grant owns the named accounts and active selection. */
import { randomUUID } from 'node:crypto'
import { symbols } from '@deepseek-ai/cordis'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CodexAccountPayload } from './oauth.ts'
import { codexClaims } from './oauth.ts'

export const STORE_SCOPE = 'openai-codex'
export const ACCOUNT_POOL_KEY = credentialKey(STORE_SCOPE, 'accounts')
interface AccountPool {
  kind: 'codex-accounts-v2'
  accounts: CodexAccountPayload[]
  active?: string
  selectionId?: string
}
export interface AccountSelection {
  id: string
  account?: CodexAccountPayload
}

function account(value: unknown): CodexAccountPayload {
  if (!value || typeof value !== 'object') throw new Error('Invalid Codex account grant')
  const row = value as Partial<CodexAccountPayload>
  if (
    row.kind !== 'codex-account-v1' ||
    typeof row.name !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(row.name) ||
    !row.tokens ||
    typeof row.tokens.accessToken !== 'string' ||
    !row.tokens.accessToken ||
    !Number.isFinite(row.tokens.expiresAt)
  )
    throw new Error('Invalid Codex account grant')
  const claims = row.tokens.idToken ? codexClaims(row.tokens.idToken) : undefined
  return structuredClone({
    ...row,
    ...(typeof claims?.chatgpt_account_id === 'string'
      ? { accountId: claims.chatgpt_account_id }
      : {}),
    ...(typeof claims?.chatgpt_plan_type === 'string'
      ? { planType: claims.chatgpt_plan_type }
      : {}),
  } as CodexAccountPayload)
}
function pool(record: CredentialRecord | undefined): AccountPool {
  if (!record) return { kind: 'codex-accounts-v2', accounts: [] }
  if (record.kind !== 'grant' || !record.payload || typeof record.payload !== 'object')
    throw new Error('Invalid Codex account pool')
  const row = record.payload as Partial<AccountPool>
  if (
    row.kind !== 'codex-accounts-v2' ||
    typeof row.selectionId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.selectionId) ||
    !Array.isArray(row.accounts) ||
    row.accounts.length > 128
  )
    throw new Error('Invalid Codex account pool')
  const accounts = row.accounts.map(account)
  if (
    new Set(accounts.map((account) => account.name)).size !== accounts.length ||
    (row.active !== undefined && !accounts.some((account) => account.name === row.active))
  )
    throw new Error('Invalid Codex active account')
  return {
    kind: 'codex-accounts-v2',
    accounts,
    selectionId: row.selectionId,
    ...(row.active !== undefined ? { active: row.active } : {}),
  }
}
function put(current: AccountPool, next: CodexAccountPayload): AccountPool {
  const accounts = [
    ...current.accounts.filter((account) => account.name !== next.name),
    account(next),
  ].sort((a, b) => a.name.localeCompare(b.name))
  if (accounts.length > 128) throw new Error('Codex account limit reached')
  return { ...current, accounts, selectionId: current.selectionId ?? randomUUID() }
}

export interface CodexAccountStore {
  list(): Promise<readonly string[]>
  read(name: string): Promise<CodexAccountPayload | undefined>
  write(
    name: string,
    update: (
      previous: CodexAccountPayload | undefined,
    ) => CodexAccountPayload | Promise<CodexAccountPayload>,
    expectedAccessToken?: string,
  ): Promise<CodexAccountPayload>
  remove(name: string): Promise<boolean>
  active(): Promise<string | undefined>
  activeAccount(): Promise<CodexAccountPayload | undefined>
  selection(): Promise<AccountSelection>
  switchActive(expectedSelectionId: string, name: string): Promise<AccountSelection | undefined>
  setActive(name: string | undefined): Promise<void>
}
export interface CodexAuthorizationStore extends CodexAccountStore {
  /** The authorization seam commits the real account pool, once, while account mutations are serialized. */
  authorize(
    next: CodexAccountPayload,
    commit: (record: CredentialRecord) => Promise<void>,
  ): Promise<void>
}
const locks = new WeakMap<CredentialProvider, { tail: Promise<unknown> }>()

export function accountStoreOf(credentials: CredentialProvider): CodexAuthorizationStore {
  const original =
    (Reflect.get(credentials, symbols.original) as CredentialProvider | undefined) ?? credentials
  const lock = locks.get(original) ?? { tail: Promise.resolve() }
  locks.set(original, lock)
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lock.tail.then(operation, operation)
    lock.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const read = async () => pool(await credentials.readRecord(ACCOUNT_POOL_KEY))
  const store: CodexAuthorizationStore = {
    async list() {
      return (await read()).accounts.map((account) => account.name)
    },
    async read(name) {
      return (await read()).accounts.find((account) => account.name === name)
    },
    write(name, update, expectedAccessToken) {
      return serialize(async () => {
        let written: CodexAccountPayload | undefined
        await credentials.modifyRecord(ACCOUNT_POOL_KEY, async (record) => {
          const current = pool(record)
          const previous = current.accounts.find((account) => account.name === name)
          if (
            expectedAccessToken !== undefined &&
            previous?.tokens.accessToken !== expectedAccessToken
          ) {
            if (!previous) throw new Error('Codex account was removed during token refresh')
            written = previous
            return undefined
          }
          written = account(await update(previous))
          if (written.name !== name) throw new Error('An account update cannot change its identity')
          return { kind: 'grant', payload: put(current, written) }
        })
        return written!
      })
    },
    remove(name) {
      return serialize(async () => {
        const current = await read()
        if (!current.accounts.some((account) => account.name === name)) return false
        const accounts = current.accounts.filter((account) => account.name !== name)
        if (!accounts.length) await credentials.deleteRecord(ACCOUNT_POOL_KEY)
        else {
          const next: AccountPool = {
            kind: 'codex-accounts-v2',
            accounts,
            selectionId: current.active === name ? randomUUID() : current.selectionId,
            ...(current.active !== name && current.active !== undefined
              ? { active: current.active }
              : {}),
          }
          await credentials.modifyRecord(ACCOUNT_POOL_KEY, async () => ({
            kind: 'grant',
            payload: next,
          }))
        }
        return true
      })
    },
    async active() {
      return (await read()).active
    },
    async activeAccount() {
      const current = await read()
      return current.accounts.find((account) => account.name === current.active)
    },
    async selection() {
      const current = await read()
      return {
        id: current.selectionId ?? '',
        account: current.accounts.find((account) => account.name === current.active),
      }
    },
    switchActive(expectedSelectionId, name) {
      return serialize(async () => {
        let selected: AccountSelection | undefined
        await credentials.modifyRecord(ACCOUNT_POOL_KEY, async (record) => {
          const current = pool(record),
            next = current.accounts.find((account) => account.name === name)
          if (current.selectionId !== expectedSelectionId || !next) return undefined
          const id = randomUUID()
          selected = { id, account: account(next) }
          return { kind: 'grant', payload: { ...current, active: name, selectionId: id } }
        })
        return selected
      })
    },
    setActive(name) {
      return serialize(async () => {
        await credentials.modifyRecord(ACCOUNT_POOL_KEY, async (record) => {
          const current = pool(record)
          if (name !== undefined && !current.accounts.some((account) => account.name === name))
            throw new Error('The selected Codex account does not exist')
          return {
            kind: 'grant',
            payload: {
              kind: 'codex-accounts-v2',
              accounts: current.accounts,
              selectionId: randomUUID(),
              ...(name !== undefined ? { active: name } : {}),
            },
          }
        })
      })
    },
    authorize(next, commit) {
      return serialize(async () => {
        const current = await read()
        const updated = {
          ...put(current, account(next)),
          active: next.name,
          selectionId: randomUUID(),
        }
        await commit({ kind: 'grant', payload: updated })
      })
    },
  }
  return store
}
