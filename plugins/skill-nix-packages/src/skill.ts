/**
 * Nix-packages skill frontmatter domain: parsing, POSIX command quoting,
 * and wrapper-command templating. Pure domain: no harness imports, no
 * filesystem, no network.
 *
 * @module @loncothad/dsh-skill-nix-packages/skill
 */

/** One parsed SKILL.md: name, description, metadata, and body. */
export interface ParsedSkill {
  readonly name: string
  readonly description: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly content: string
}

/** Extract the YAML frontmatter block between the first two `---` lines. */
export function frontmatterOf(source: string): string | undefined {
  const lines = source.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return undefined
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (closing === -1) return undefined
  return lines.slice(1, closing).join('\n')
}

/** Parse frontmatter line-oriented: `key: value` pairs and nested maps. */
export function parseFrontmatter(block: string): Readonly<Record<string, unknown>> {
  const root: Record<string, unknown> = {}
  let current: Record<string, unknown> | undefined
  for (const line of block.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    const indented = /^\s/.test(line)
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (match === null || match[1] === undefined) continue
    const key: string = match[1]
    const rawValue = match[2] ?? ''
    if (rawValue.length === 0) {
      const nested: Record<string, unknown> = {}
      if (indented && current !== undefined) {
        current[key] = nested
      } else {
        root[key] = nested
        current = nested
      }
      continue
    }
    const value = coerce(rawValue)
    if (indented && current !== undefined) {
      current[key] = value
    } else {
      root[key] = value
      current = undefined
    }
  }
  return root
}

/** Coerce one raw frontmatter value: strip quotes, keep strings. */
function coerce(rawValue: string): string {
  const trimmed = rawValue.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Narrow an unknown metadata value to its record form. */
function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/** Parse a full SKILL.md source into name, description, metadata, body. */
export function parseSkill(source: string): ParsedSkill {
  const block = frontmatterOf(source) ?? ''
  const fields = parseFrontmatter(block)
  const lines = source.split(/\r?\n/)
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  const body =
    closing === -1
      ? ''
      : lines
          .slice(closing + 1)
          .join('\n')
          .trim()
  return {
    name: String(fields.name ?? ''),
    description: String(fields.description ?? ''),
    metadata: recordValue(fields.metadata),
    content: body,
  }
}

/** The `metadata.nix-packages` list of a parsed skill; commas or spaces. */
export function nixPackagesOf(skill: ParsedSkill): readonly string[] {
  const value = skill.metadata['nix-packages']
  if (typeof value !== 'string') return []
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
  ]
}

/** Quote one shell command for a POSIX shell (single-quote escaping). */
export function quoteCommand(command: string): string {
  return `'${command.replaceAll("'", "'\\''")}'`
}

/** Expand the wrapper template; missing {command} gets one appended. */
export function expandWrapper(
  template: string,
  packages: readonly string[],
  command: string,
): string {
  const effective = template.includes('{command}') ? template : `${template} -c {command}`
  const packagesText = packages.map((name) => `nixpkgs#${name}`).join(' ')
  const commandText = template.includes('{packages}')
    ? quoteCommand(command)
    : [packagesText, quoteCommand(command)].filter((part) => part.length > 0).join(' ')
  return effective.replaceAll('{packages}', packagesText).replaceAll('{command}', commandText)
}

/** The instruction appended to a package-declaring skill's loaded content. */
export function nixWrapperInstruction(packages: readonly string[], template: string): string {
  return [
    'This skill declares Nix packages:',
    `  ${packages.join(', ')}`,
    'Wrap its shell commands for execution with the configured pattern:',
    `  ${expandWrapper(template, packages, 'COMMAND')}`,
    `(configured pattern: ${template})`,
  ].join('\n')
}
