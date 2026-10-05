import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { expect, it } from 'vitest'
import { zaiStoreOf } from '../src/store.ts'

it('serializes account additions and keeps inactive grants when selection or removal changes', async () => {
  let record: CredentialRecord | undefined
  const credentials = {
    readRecord: async () => record,
    modifyRecord: async (
      _key: unknown,
      update: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
    ) => {
      record = await update(record)
      return record
    },
    deleteRecord: async () => {
      record = undefined
    },
  } as unknown as CredentialProvider
  const store = zaiStoreOf(credentials),
    commit = async (next: CredentialRecord) => {
      record = next
    }
  await Promise.all(
    ['first', 'second'].map((name) =>
      store.authorize(
        {
          kind: 'zai-subscription-v1',
          name,
          apiKey: `key-${name}`,
          source: 'api-key',
          storedAt: 1,
        },
        commit,
      ),
    ),
  )
  expect((await store.list()).map((row) => row.name)).toEqual(['first', 'second'])
  expect((await store.read())?.name).toBe('second')
  await store.select('first')
  expect((await store.read())?.name).toBe('first')
  await store.remove('second')
  expect((await store.read())?.name).toBe('first')
  await expect(store.select('missing')).rejects.toThrow('Unknown')
  await store.remove('first')
  expect(await store.list()).toEqual([])
})
