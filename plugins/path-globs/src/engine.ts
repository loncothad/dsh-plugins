import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import picomatch from 'picomatch'
import type { Policy } from './config.ts'
export interface Expansion {
  root: string
  cwd: string
  observedAt: string
  patterns: { pattern: string; files: string[] }[]
  files: string[]
  ignoreFiles: string[]
  scannedEntries: number
  complete: true
}
const inside = (root: string, path: string) => {
  const delta = relative(root, path)
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta))
}
const portable = (path: string) => path.split(sep).join('/')
export async function projectRoot(
  cwd: string,
  policy: Policy,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted()
  const canonical = await realpath(cwd)
  if (policy.rootMode === 'workspace') return canonical
  if (policy.rootMode === 'configured') {
    if (!policy.projectRoot || !isAbsolute(policy.projectRoot))
      throw new Error('The configured project root must be absolute')
    const root = await realpath(policy.projectRoot)
    if (!inside(root, canonical))
      throw new Error('The workspace is outside the configured project root')
    return root
  }
  let path = canonical
  for (let depth = 0; depth < 128; depth++) {
    signal.throwIfAborted()
    try {
      const info = await lstat(join(path, '.git'))
      if (info.isFile() || info.isDirectory()) return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(path)
    if (parent === path) return canonical
    path = parent
  }
  throw new Error('Project root discovery exceeded its depth limit')
}
interface Layer {
  base: string
  rules: Ignore
}
export async function expandGlobs(
  cwd: string,
  patterns: readonly string[],
  policy: Policy,
  signal: AbortSignal,
): Promise<Expansion> {
  const root = await projectRoot(cwd, policy, signal),
    canonical = await realpath(cwd),
    unique = [...new Set(patterns)]
  if (!unique.length || unique.length > policy.maxPatterns)
    throw new Error(`Choose 1–${policy.maxPatterns} distinct glob patterns`)
  const matching = unique.map((pattern) => {
    if (
      !pattern ||
      pattern.length > 2048 ||
      pattern.includes('\0') ||
      pattern.startsWith('!') ||
      pattern.includes('://')
    )
      throw new Error('Invalid file glob pattern')
    const value = process.platform === 'win32' ? pattern.replaceAll('\\', '/') : pattern
    if (value.split('/').includes('..'))
      throw new Error('Glob patterns cannot traverse outside the project')
    const absolute = resolve(canonical, value)
    if (!inside(root, absolute)) throw new Error('Glob pattern is outside the project root')
    return {
      pattern,
      match: picomatch(portable(relative(root, absolute)), {
        dot: policy.includeDotfiles,
        nocase: !policy.caseSensitive,
        strictBrackets: true,
      }),
      files: [] as string[],
    }
  })
  const result: Expansion = {
      root,
      cwd: canonical,
      observedAt: new Date().toISOString(),
      patterns: matching,
      files: [],
      ignoreFiles: [],
      scannedEntries: 0,
      complete: true,
    },
    all = new Set<string>(),
    extra = ignore({ ignorecase: !policy.caseSensitive }).add(policy.additionalExcludes)
  let ignoreBytes = 0
  const ignoreNames = policy.honorIgnoreFiles
    ? [
        ...new Set([
          ...(policy.respectGitignore ? ['.gitignore'] : []),
          ...(policy.respectIgnore ? ['.ignore'] : []),
          ...policy.additionalIgnoreFiles,
        ]),
      ]
    : []
  const readRules = async (directory: string): Promise<Layer | undefined> => {
    const rules = ignore({ ignorecase: !policy.caseSensitive })
    let loaded = false
    for (const name of ignoreNames) {
      signal.throwIfAborted()
      const path = join(directory, name)
      let file: Awaited<ReturnType<typeof open>> | undefined
      try {
        const info = await lstat(path)
        if (info.isSymbolicLink()) throw new Error('Ignore files must not be symlinks')
        if (!info.isFile()) throw new Error('Ignore path is not a regular file')
        ignoreBytes += info.size
        if (ignoreBytes > policy.maxIgnoreBytes)
          throw new Error('Ignore files exceeded the byte limit')
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const buffer = Buffer.alloc(info.size + 1),
          { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead > info.size) throw new Error('Ignore file changed size during enumeration')
        rules.add(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)))
        result.ignoreFiles.push(portable(relative(root, path)))
        loaded = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      } finally {
        await file?.close()
      }
    }
    return loaded ? { base: directory, rules } : undefined
  }
  const excluded = (path: string, directory: boolean, layers: readonly Layer[]) => {
    let denied = false
    for (const layer of layers) {
      const local = portable(relative(layer.base, path)) + (directory ? '/' : '')
      if (!local || local.startsWith('../')) continue
      const state = layer.rules.test(local)
      if (state.ignored) denied = true
      else if (state.unignored) denied = false
    }
    return denied || extra.ignores(portable(relative(root, path)) + (directory ? '/' : ''))
  }
  const walk = async (
    directory: string,
    layers: readonly Layer[],
    depth: number,
  ): Promise<void> => {
    signal.throwIfAborted()
    if (depth > policy.maxDepth) throw new Error('Glob scan exceeded the directory-depth limit')
    const actual = await realpath(directory)
    if (!inside(root, actual) || actual !== directory)
      throw new Error('Glob scan encountered an escaped or replaced directory')
    const local = depth === 0 || policy.nestedIgnoreFiles ? await readRules(directory) : undefined,
      active = local ? [...layers, local] : layers
    const entries = await opendir(directory, { bufferSize: 64 })
    for await (const entry of entries) {
      signal.throwIfAborted()
      if (++result.scannedEntries > policy.maxScanEntries)
        throw new Error('Glob scan exceeded the entry limit')
      if (entry.name === '.git' || entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (excluded(path, entry.isDirectory(), active)) continue
      if (entry.isDirectory()) {
        await walk(path, active, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      for (const row of matching)
        if (row.match(portable(relative(root, path)))) {
          const real = await realpath(path)
          if (!inside(root, real) || real !== path)
            throw new Error('Matched file was replaced or escaped the project')
          const name = portable(relative(root, path))
          row.files.push(name)
          all.add(name)
          if (all.size > policy.maxMatches)
            throw new Error(
              'Glob expansion exceeded the match limit; no partial file list was returned',
            )
        }
    }
    if ((await realpath(directory)) !== actual)
      throw new Error('Project directory changed during glob enumeration')
  }
  await walk(root, [], 0)
  signal.throwIfAborted()
  result.patterns = matching.map(({ pattern, files }) => ({ pattern, files: files.sort() }))
  result.files = [...all].sort()
  result.ignoreFiles.sort()
  if (Buffer.byteLength(JSON.stringify(result, null, 2)) > policy.maxResultBytes)
    throw new Error(
      'Glob expansion exceeded the result byte limit; no partial file list was returned',
    )
  return result
}
