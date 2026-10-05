import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { publishMediaFile } from '../src/publication.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-publication-'))
  directories.push(dir)
  return { dir, path: join(dir, 'output.png') }
}
it('creates exclusively and rolls back its own file idempotently', async () => {
  const { path } = await fixture()
  const receipt = await publishMediaFile(path, Buffer.from('generated'))
  await expect(publishMediaFile(path, Buffer.from('overwrite'))).rejects.toMatchObject({
    code: 'EEXIST',
  })
  expect(await readFile(path, 'utf8')).toBe('generated')
  await receipt.rollback()
  await receipt.rollback()
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})
for (const change of ['modified', 'replaced', 'symlink'] as const) {
  it(`preserves a ${change} file during rollback`, async () => {
    const { dir, path } = await fixture()
    const receipt = await publishMediaFile(path, Buffer.from('generated'))
    if (change === 'modified') await writeFile(path, 'user edit with different length')
    else {
      await unlink(path)
      if (change === 'replaced') await writeFile(path, 'replacement')
      else {
        const target = join(dir, 'target')
        await writeFile(target, 'target')
        await symlink(target, path)
      }
    }
    await expect(receipt.rollback()).rejects.toThrow('changed')
    expect(await readFile(path, 'utf8')).toBe(
      change === 'modified'
        ? 'user edit with different length'
        : change === 'replaced'
          ? 'replacement'
          : 'target',
    )
  })
}
it('rejects an already cancelled publication before creating a file', async () => {
  const { path } = await fixture()
  const abort = new AbortController()
  abort.abort(new Error('cancelled'))
  await expect(publishMediaFile(path, Buffer.from('generated'), abort.signal)).rejects.toThrow(
    'cancelled',
  )
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})
