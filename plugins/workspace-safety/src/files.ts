import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
export interface Snapshot {
  version: 1
  id: string
  createdAt: string
  source: string
  commit: string
  files: { path: string; hash: string; bytes: number; mode: number }[]
  omitted: string[]
}
export interface FileLimits {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  timeoutMs: number
}
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
async function durableFile(path: string, bytes: string | Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
export const inside = (root: string, path: string) => {
  const delta = relative(root, path)
  return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta))
}
export async function git(
  cwd: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs = 30000,
): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      'git',
      ['--no-pager', '-C', cwd, ...args],
      {
        signal,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
      },
      (error, output) =>
        error ? reject(new Error('Git workspace operation failed')) : resolve(output),
    ),
  )
}
export async function scan(
  root: string,
  limits: FileLimits,
  signal: AbortSignal,
): Promise<{ files: { path: string; bytes: Buffer; mode: number }[]; omitted: string[] }> {
  const names = (
      await git(
        root,
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        signal,
        limits.timeoutMs,
      )
    )
      .split('\0')
      .filter(Boolean),
    files: { path: string; bytes: Buffer; mode: number }[] = [],
    omitted: string[] = []
  if (new Set(names).size > limits.maxFiles)
    throw new Error('Workspace checkpoint file limit exceeded')
  let total = 0
  for (const name of [...new Set(names)].sort()) {
    signal.throwIfAborted()
    const path = resolve(root, name),
      delta = relative(root, path)
    if (!name || isAbsolute(name) || delta.startsWith('..') || inside(join(root, '.git'), path))
      throw new Error('Checkpoint path escaped the repository')
    if (
      ['.env', '.env.local', '.credentials.yaml', '.npmrc', 'id_rsa', 'id_ed25519'].includes(
        name.split(/[\\/]/).at(-1)!,
      )
    ) {
      omitted.push(name)
      continue
    }
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Checkpoint contains an unsupported symbolic link or file kind')
    total += info.size
    if (info.size > limits.maxFileBytes || total > limits.maxTotalBytes)
      throw new Error('Checkpoint byte limit exceeded')
    const bytes = await readFile(path)
    if (bytes.length !== info.size) throw new Error('File changed during checkpoint capture')
    files.push({ path: delta.replaceAll('\\', '/'), bytes, mode: info.mode & 0o777 })
  }
  return { files, omitted }
}
export class Checkpoints {
  constructor(
    readonly directory: string,
    private readonly limits: FileLimits,
  ) {}
  private async prepare(source: string): Promise<string> {
    const root = await realpath(source)
    if (!isAbsolute(this.directory) || inside(root, resolve(this.directory)))
      throw new Error('Checkpoint storage must be outside the working repository')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
    )
      throw new Error('Checkpoint storage must be a private real directory')
    return root
  }
  async capture(source: string, signal: AbortSignal): Promise<Snapshot> {
    const root = await this.prepare(source),
      head = (await git(root, ['rev-parse', 'HEAD'], signal)).trim(),
      before = await scan(root, this.limits, signal)
    const files = before.files.map((file) => ({
        path: file.path,
        hash: sha(file.bytes),
        bytes: file.bytes.length,
        mode: file.mode,
      })),
      createdAt = new Date().toISOString(),
      id = sha(JSON.stringify({ source: root, head, files, createdAt })),
      snapshot: Snapshot = {
        version: 1,
        id,
        createdAt,
        source: root,
        commit: head,
        files,
        omitted: before.omitted,
      }
    const staging = join(this.directory, `.capture-${randomUUID()}`),
      target = join(this.directory, id)
    await mkdir(staging, { mode: 0o700 })
    try {
      await mkdir(join(staging, 'objects'), { mode: 0o700 })
      for (const file of before.files)
        await durableFile(join(staging, 'objects', sha(file.bytes)), file.bytes).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        })
      const after = await scan(root, this.limits, signal)
      if (
        JSON.stringify(
          after.files.map((file) => ({ path: file.path, hash: sha(file.bytes), mode: file.mode })),
        ) !== JSON.stringify(files.map(({ path, hash, mode }) => ({ path, hash, mode }))) ||
        head !== (await git(root, ['rev-parse', 'HEAD'], signal)).trim()
      )
        throw new Error('Workspace changed before checkpoint publication')
      signal.throwIfAborted()
      await durableFile(join(staging, 'manifest.json'), `${JSON.stringify(snapshot, null, 2)}\n`)
      await syncDirectory(join(staging, 'objects'))
      await syncDirectory(staging)
      await rename(staging, target)
      await syncDirectory(this.directory)
      return snapshot
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  async read(id: string): Promise<Snapshot> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid checkpoint ID')
    const value = JSON.parse(
      await readFile(join(this.directory, id, 'manifest.json'), 'utf8'),
    ) as Snapshot
    if (
      value.version !== 1 ||
      value.id !== id ||
      !Array.isArray(value.files) ||
      value.files.length > this.limits.maxFiles ||
      !Array.isArray(value.omitted)
    )
      throw new Error('Invalid checkpoint manifest')
    if (
      sha(
        JSON.stringify({
          source: value.source,
          head: value.commit,
          files: value.files,
          createdAt: value.createdAt,
        }),
      ) !== id
    )
      throw new Error('Checkpoint manifest integrity failed')
    let bytes = 0
    const seen = new Set<string>()
    for (const file of value.files) {
      bytes += file.bytes
      if (
        typeof file.path !== 'string' ||
        !file.path ||
        isAbsolute(file.path) ||
        file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
        seen.has(file.path) ||
        !/^[a-f0-9]{64}$/.test(file.hash) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        file.bytes > this.limits.maxFileBytes ||
        bytes > this.limits.maxTotalBytes ||
        !Number.isInteger(file.mode)
      )
        throw new Error('Invalid checkpoint file')
      seen.add(file.path)
    }
    return value
  }
  async list(): Promise<{ id: string; createdAt: string; files: number; omitted: number }[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const names = (await readdir(this.directory)).filter((name) => /^[a-f0-9]{64}$/.test(name))
    if (names.length > 1000) throw new Error('Checkpoint inspection capacity exceeded')
    return Promise.all(
      names.map(async (id) => {
        const value = await this.read(id)
        return {
          id,
          createdAt: value.createdAt,
          files: value.files.length,
          omitted: value.omitted.length,
        }
      }),
    )
  }
  async restore(id: string, target: string, signal: AbortSignal): Promise<void> {
    if (!isAbsolute(target)) throw new Error('Restore target must be absolute')
    const snapshot = await this.read(id)
    await mkdir(target, { recursive: true, mode: 0o700 })
    if ((await readdir(target)).length)
      throw new Error('Restore requires an empty directory; existing work is never overwritten')
    const leaf = await lstat(target)
    if (leaf.isSymbolicLink() || !leaf.isDirectory())
      throw new Error('Restore requires a real empty directory')
    const actual = await realpath(target)
    if (inside(this.directory, actual) || inside(actual, this.directory))
      throw new Error('Restore cannot overwrite checkpoint storage')
    const staging = join(dirname(actual), `.restore-${randomUUID()}`)
    await mkdir(staging, { mode: 0o700 })
    try {
      for (const file of snapshot.files) {
        signal.throwIfAborted()
        const bytes = await readFile(join(this.directory, id, 'objects', file.hash))
        if (bytes.length !== file.bytes || sha(bytes) !== file.hash)
          throw new Error('Checkpoint object failed integrity validation')
        const path = join(staging, file.path)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, bytes, { mode: file.mode & 0o777 })
        if (process.platform !== 'win32') await chmod(path, file.mode & 0o777)
      }
      signal.throwIfAborted()
      await rmdir(actual)
      await rename(staging, actual)
      await syncDirectory(dirname(actual))
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  async diff(
    id: string,
    source: string,
    signal: AbortSignal,
  ): Promise<{ path: string; change: 'added' | 'removed' | 'modified' }[]> {
    const old = await this.read(id),
      current = await scan(await realpath(source), this.limits, signal),
      before = new Map(old.files.map((file) => [file.path, file.hash])),
      after = new Map(current.files.map((file) => [file.path, sha(file.bytes)]))
    return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) =>
      before.get(path) === after.get(path)
        ? []
        : [
            {
              path,
              change: !before.has(path)
                ? ('added' as const)
                : !after.has(path)
                  ? ('removed' as const)
                  : ('modified' as const),
            },
          ],
    )
  }
}
export async function createWorktree(
  source: string,
  root: string,
  branch: string,
  limits: FileLimits,
  signal: AbortSignal,
): Promise<string> {
  const repository = await realpath(source),
    destination = resolve(root)
  if (inside(repository, destination) || !isAbsolute(root))
    throw new Error('Worktrees must live outside the raw repository')
  await git(repository, ['check-ref-format', '--branch', branch], signal)
  const current = await scan(repository, limits, signal),
    target = join(destination, sha(branch).slice(0, 24))
  await mkdir(destination, { recursive: true, mode: 0o700 })
  await git(repository, ['worktree', 'add', '-b', branch, target, 'HEAD'], signal, limits.timeoutMs)
  try {
    for (const file of current.files) {
      signal.throwIfAborted()
      const path = join(target, file.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, file.bytes, { mode: file.mode & 0o777 })
    }
    const captured = new Set(current.files.map((file) => file.path)),
      tracked = (await git(target, ['ls-files', '-z'], signal)).split('\0').filter(Boolean)
    for (const file of tracked)
      if (!captured.has(file)) await rm(join(target, file), { force: true })
    return target
  } catch {
    await git(
      repository,
      ['worktree', 'remove', '--force', target],
      new AbortController().signal,
    ).catch(() => {})
    await git(repository, ['branch', '-D', branch], new AbortController().signal).catch(() => {})
    throw new Error('Worktree initialization failed; raw repository was preserved')
  }
}
