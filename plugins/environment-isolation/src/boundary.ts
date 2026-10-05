import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Environment } from '@loncothad/dsh-execution-core'
export function inside(root: string, path: string): boolean {
  const delta = relative(root, path)
  return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta))
}
export async function inspectBoundary(
  root: string,
  environment: Environment,
  hostHome: string,
): Promise<{ valid: boolean; reason: string; root: string; home: string }> {
  const fail = (reason: string) => ({
    valid: false,
    reason,
    root: resolve(root),
    home: resolve(hostHome),
  })
  if (!isAbsolute(root) || !isAbsolute(hostHome))
    return fail('Environment root and DSH_HOME must be absolute.')
  try {
    const canonicalRoot = await realpath(root),
      expected = join(canonicalRoot, environment),
      home = await realpath(hostHome)
    if (home !== expected)
      return fail(
        `This host must start with DSH_HOME=${expected}. A running host cannot switch deployment identity.`,
      )
    for (const name of ['dev', 'staging', 'prod']) {
      try {
        const info = await lstat(join(canonicalRoot, name))
        if (info.isSymbolicLink() || !info.isDirectory())
          return fail('Environment homes must be independent real directories.')
        if (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
          return fail('Environment homes must be private directories (0700).')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return {
      valid: true,
      reason: `Verified ${environment} deployment home.`,
      root: canonicalRoot,
      home,
    }
  } catch {
    return fail(
      'The deployment home could not be verified. Prepare separate private environment homes first.',
    )
  }
}
