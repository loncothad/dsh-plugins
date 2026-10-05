import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
async function git(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-pager', '-C', cwd, ...args],
      {
        signal,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 5000,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
      },
      (error, output) =>
        error ? reject(new Error('Workspace Git snapshot unavailable')) : resolve(output),
    )
  })
}
/** Snapshot actual workspace bytes, not the model's mutation claims. */
export async function workspaceFingerprint(cwd: string, signal: AbortSignal): Promise<string> {
  let prefix = 'filesystem',
    files: string[] = []
  try {
    const [head, diff, untracked] = await Promise.all([
      git(cwd, ['rev-parse', 'HEAD'], signal),
      git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--'], signal),
      git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], signal),
    ])
    prefix = `git:${head.trim()}:${hash(diff)}`
    files = untracked.split('\0').filter(Boolean)
  } catch {
    signal.throwIfAborted()
    const walk = async (path: string, depth: number) => {
      if (depth > 12) throw new Error('Workspace snapshot depth exceeded')
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (
          ['.git', 'node_modules', '.qualification', 'artifacts', '.env', '.env.local'].includes(
            entry.name,
          )
        )
          continue
        const absolute = join(path, entry.name)
        if (entry.isSymbolicLink())
          throw new Error('Workspace snapshot has an unsupported symbolic link')
        if (entry.isDirectory()) await walk(absolute, depth + 1)
        else if (entry.isFile()) files.push(relative(cwd, absolute))
        if (files.length > 2048) throw new Error('Workspace snapshot file limit exceeded')
      }
    }
    await walk(cwd, 0)
  }
  if (files.length > 2048) throw new Error('Workspace snapshot file limit exceeded')
  let bytes = 0
  const parts = [prefix]
  for (const file of files.sort()) {
    signal.throwIfAborted()
    const path = join(cwd, file),
      delta = relative(cwd, path)
    if (delta.startsWith('..') || isAbsolute(delta))
      throw new Error('Workspace snapshot path escaped')
    const info = await lstat(path)
    bytes += info.size
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576 || bytes > 16 * 1024 * 1024)
      throw new Error('Workspace snapshot exceeds its safe bounds')
    parts.push(`${file}:${hash(await readFile(path))}`)
  }
  return hash(parts.join('\n'))
}
