/**
 * Superprompt file mapping: parse, serialize, exact-then-suffix designator
 * resolution. Pure domain.
 *
 * @module @loncothad/dsh-system-prompt-agents-switch/mapping
 */

/** One designator→file mapping entry. */
export interface MappingEntry {
  /** `provider/model` designator, bare model, or model suffix. */
  readonly designator: string
  /** Superprompt file path, absolute or workspace-relative. */
  readonly file: string
}

/** Parse the semicolon-joined `designator=file` mapping setting. */
export function parseMapping(value: string | undefined): readonly MappingEntry[] {
  if (value === undefined || value.trim().length === 0) return []
  const entries: MappingEntry[] = []
  for (const raw of value.split(';')) {
    const split = raw.indexOf('=')
    if (split === -1) continue
    const designator = raw.slice(0, split).trim()
    const file = raw.slice(split + 1).trim()
    if (designator.length > 0 && file.length > 0) {
      entries.push({ designator, file })
    }
  }
  return entries
}

/** Serialize entries back into the setting form. */
export function serializeMapping(entries: readonly MappingEntry[]): string {
  return entries.map((entry) => `${entry.designator}=${entry.file}`).join(';')
}

/** Set (or replace) one designator's mapping. */
export function setMapping(
  entries: readonly MappingEntry[],
  designator: string,
  file: string,
): readonly MappingEntry[] {
  return [
    ...entries.filter((entry) => entry.designator.toLowerCase() !== designator.toLowerCase()),
    { designator, file },
  ]
}

/** Remove one designator's exact mapping; reports whether one existed. */
export function clearMapping(
  entries: readonly MappingEntry[],
  designator: string,
): { entries: readonly MappingEntry[]; removed: boolean } {
  const filtered = entries.filter(
    (entry) => entry.designator.toLowerCase() !== designator.toLowerCase(),
  )
  return { entries: filtered, removed: filtered.length !== entries.length }
}

/** Whether `value` ends with `suffix`, case-sensitively. */
export function endsWith(value: string, suffix: string): boolean {
  return value.length >= suffix.length && value.slice(-suffix.length) === suffix
}

/**
 * Resolve the superprompt file for one designator: an exact (case-insensitive)
 * entry first, then a model-name suffix entry, else the default file.
 */
export function fileFor(
  entries: readonly MappingEntry[],
  designator: string,
  model: string | undefined,
  defaultFile: string,
): string {
  const exact = entries.find((entry) => entry.designator.toLowerCase() === designator.toLowerCase())
  if (exact !== undefined) return exact.file
  if (model !== undefined) {
    for (const entry of entries) {
      if (endsWith(model, entry.designator)) return entry.file
    }
  }
  return defaultFile
}

/** The default file needs no injection when it is the built-in one. */
export function BUILTIN(): string {
  return 'AGENTS.md'
}
