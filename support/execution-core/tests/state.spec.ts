import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PrivateStateJournal } from '../src/state.ts'

const roots: string[] = [],
  journals: PrivateStateJournal[] = []
afterEach(async () => {
  await Promise.all(journals.splice(0).map((journal) => journal.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-private-state-'))
  roots.push(root)
  const path = join(root, 'state.sqlite'),
    open = async () => {
      const journal = await PrivateStateJournal.open(path)
      journals.push(journal)
      return journal
    }
  return { root, path, open }
}
it('replays private snapshots after restart and respects source cursor/time cuts', async () => {
  const f = await fixture(),
    journal = await f.open()
  const first = await journal.write('session', 0, 4, { criteria: 'Never publish', cursor: 4 }),
    second = await journal.write('session', 1, 9, { criteria: 'Only prepare artifacts', cursor: 9 })
  await journal.close()
  const reopened = await f.open()
  expect((await reopened.read('session'))?.value).toEqual(second.value)
  expect((await reopened.read('session', 4, second.observedAt))?.value).toEqual(first.value)
  expect(await reopened.read('session', 3)).toBeNull()
})
it('fences concurrent writers and refuses oversized state without replacing the live snapshot', async () => {
  const f = await fixture(),
    one = await f.open(),
    two = await f.open(),
    results = await Promise.allSettled([
      one.write('shared', 0, 1, { owner: 1 }),
      two.write('shared', 0, 1, { owner: 2 }),
    ])
  expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1)
  const live = await one.read('shared')
  await expect(
    two.write('shared', live!.revision, 1, { body: '🌍'.repeat(40000) }),
  ).rejects.toThrow('rejected')
  expect(await one.read('shared')).toEqual(live)
})
