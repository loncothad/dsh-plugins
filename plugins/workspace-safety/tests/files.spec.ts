import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Checkpoints, createWorktree, git } from '../src/files.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
const limits = { maxFiles: 64, maxFileBytes: 1048576, maxTotalBytes: 8388608, timeoutMs: 10000 },
  signal = () => new AbortController().signal
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-test-'))
  dirs.push(root)
  const repo = join(root, 'repo'),
    storage = join(root, 'private'),
    worktrees = join(root, 'worktrees')
  await mkdir(repo)
  await git(repo, ['init'], signal())
  await git(repo, ['config', 'user.name', 'Fixture'], signal())
  await git(repo, ['config', 'user.email', 'fixture@example.invalid'], signal())
  await writeFile(join(repo, 'file.txt'), 'committed')
  await git(repo, ['add', 'file.txt'], signal())
  await git(repo, ['commit', '-m', 'Initial fixture'], signal())
  return { root, repo, storage, worktrees, checkpoints: new Checkpoints(storage, limits) }
}
it('copies current uncommitted work into a dedicated branch without resetting the raw repository', async () => {
  const f = await fixture()
  await writeFile(join(f.repo, 'file.txt'), 'uncommitted')
  await writeFile(join(f.repo, 'new.txt'), 'untracked')
  const before = await git(f.repo, ['status', '--porcelain'], signal()),
    branch = await git(f.repo, ['branch', '--show-current'], signal())
  const path = await createWorktree(f.repo, f.worktrees, 'dsh/dev/fixture', limits, signal())
  expect(await readFile(join(path, 'file.txt'), 'utf8')).toBe('uncommitted')
  expect(await readFile(join(path, 'new.txt'), 'utf8')).toBe('untracked')
  expect(await git(f.repo, ['status', '--porcelain'], signal())).toBe(before)
  expect(await git(f.repo, ['branch', '--show-current'], signal())).toBe(branch)
  expect((await git(path, ['branch', '--show-current'], signal())).trim()).toBe('dsh/dev/fixture')
})
it('restores checkpoint content after the entire original repository is deleted', async () => {
  const f = await fixture()
  await writeFile(join(f.repo, 'file.txt'), 'checkpoint content')
  await writeFile(join(f.repo, '.env.local'), 'private credential')
  const snapshot = await f.checkpoints.capture(f.repo, signal())
  expect(snapshot.omitted).toContain('.env.local')
  await rm(f.repo, { recursive: true, force: true })
  const restored = join(f.root, 'recovered')
  await f.checkpoints.restore(snapshot.id, restored, signal())
  expect(await readFile(join(restored, 'file.txt'), 'utf8')).toBe('checkpoint content')
  await expect(readFile(join(restored, '.env.local'))).rejects.toThrow()
  expect((await f.checkpoints.list()).map((row) => row.id)).toContain(snapshot.id)
})
it('diffs actual working bytes and rejects corrupt objects or existing nonempty restore targets', async () => {
  const f = await fixture(),
    snapshot = await f.checkpoints.capture(f.repo, signal())
  await writeFile(join(f.repo, 'file.txt'), 'changed')
  expect(await f.checkpoints.diff(snapshot.id, f.repo, signal())).toEqual([
    { path: 'file.txt', change: 'modified' },
  ])
  await expect(f.checkpoints.restore(snapshot.id, f.repo, signal())).rejects.toThrow('empty')
  await writeFile(join(f.storage, snapshot.id, 'objects', snapshot.files[0]!.hash), 'tampered')
  await expect(
    f.checkpoints.restore(snapshot.id, join(f.root, 'corrupt-restore'), signal()),
  ).rejects.toThrow('integrity')
})
it('refuses backup storage inside the repository and enforces byte bounds before publication', async () => {
  const f = await fixture()
  await expect(
    new Checkpoints(join(f.repo, 'backups'), limits).capture(f.repo, signal()),
  ).rejects.toThrow('outside')
  await writeFile(join(f.repo, 'large.txt'), 'x'.repeat(2048))
  await expect(
    new Checkpoints(f.storage, { ...limits, maxFileBytes: 1024 }).capture(f.repo, signal()),
  ).rejects.toThrow('byte')
  expect(await f.checkpoints.list()).toEqual([])
})
