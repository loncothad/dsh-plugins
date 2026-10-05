/**
 * Devenv.sh project detection and command rewriting. Pure domain:
 * filesystem and shell access are injected, so every rule is testable
 * offline.
 *
 * @module @loncothad/dsh-shell-devenv/devenv
 */

/** Marker filenames that declare a devenv-managed project root. */
export const DEVENV_MARKERS = ['devenv.nix', 'devenv.yaml'] as const

/** Filesystem surface the detection walk reads through. */
export interface DevenvIo {
  /** Directory listing of one path; throws when unreadable. */
  readdir(path: string): Promise<readonly string[]>
  /** Whether the path is reachable; false for unreadable or missing. */
  accessible(path: string): Promise<boolean>
}

/**
 * Find the nearest directory at or above `start` declaring devenv.sh, or
 * `undefined`. The walk stops at the filesystem root.
 */
export async function findDevenvRoot(start: string, io: DevenvIo): Promise<string | undefined> {
  let current = normalizeDir(start)
  let previous: string | undefined
  while (current !== previous && current.length > 0) {
    for (const marker of DEVENV_MARKERS) {
      if (await io.accessible(`${current}/${marker}`)) return current
    }
    previous = current
    const parent = parentOf(current)
    current = parent
  }
  return undefined
}

/** Quote one shell command for a POSIX shell (single-quote escaping). */
export function quoteCommand(command: string): string {
  return `'${command.replaceAll("'", "'\\''")}'`
}

/** Expand the wrapper template; missing `{command}` gets one appended. */
export function expandWrapper(template: string, command: string): string {
  const effective = template.includes('{command}') ? template : `${template} -c {command}`
  return effective.replaceAll('{command}', quoteCommand(command))
}

/** Whether wrapping applies under one mode for one detection outcome. */
export function wrappingApplies(mode: 'auto' | 'on' | 'off', detected: boolean): boolean {
  if (mode === 'off') return false
  if (mode === 'on') return true
  return detected
}

/** Strip trailing separators and normalize backslashes for walking. */
function normalizeDir(path: string): string {
  let normalized = path.replace(/\/+$/, '')
  if (normalized.length === 0) normalized = '/'
  return normalized
}

/** POSIX-style parent of a normalized absolute path; '' at the root. */
function parentOf(path: string): string {
  if (path === '/' || path === '') return ''
  const slash = path.lastIndexOf('/')
  return slash <= 0 ? '/' : path.slice(0, slash)
}
