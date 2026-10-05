import Schema from '@deepseek-ai/schemastery'

const ignoreFilename =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Deliberate control-character filtering at an input or log boundary.
  /^(?!\.{1,2}$)(?!\.git(?:ignore)?$)(?!\.ignore$)(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$))(?!\s)(?!.*\s$)(?!.*\.$)[^\x00-\x1f\x7f/\\:*?"<>|]{1,128}$/i
export const schema = Schema.object({
  automatic: Schema.boolean()
    .default(true)
    .description(
      'Expand file patterns in newly admitted human messages. Original text and attachments remain intact; file lists are appended as a bounded data snapshot.',
    ),
  commandEnabled: Schema.boolean()
    .default(true)
    .description('Enable /glob preview PATTERN and the session preview panel.'),
  rootMode: Schema.union(['git', 'workspace', 'configured'])
    .default('git')
    .description(
      'Git uses the nearest repository root above the session directory, falling back to the workspace. Workspace uses the exact session directory. Configured uses the absolute project root below.',
    ),
  projectRoot: Schema.string().description(
    'Absolute root when Configured is selected. File patterns are interpreted relative to the session directory; ignore rules start at the project root.',
  ),
  honorIgnoreFiles: Schema.boolean()
    .default(true)
    .description(
      'Read project ignore files during expansion. Disable to bypass .gitignore, .ignore and all additional ignore files. Explicit Additional exclusions and Git-metadata exclusion still apply.',
    ),
  respectGitignore: Schema.boolean()
    .default(true)
    .description(
      'Honor .gitignore files. Negations and directory exclusions follow Git ignore semantics.',
    ),
  respectIgnore: Schema.boolean()
    .default(true)
    .description('Honor .ignore files after .gitignore at the same directory.'),
  additionalIgnoreFiles: Schema.array(Schema.string().pattern(ignoreFilename))
    .max(32)
    .default([])
    .description(
      'Additional ignore-file names, one per line, such as .dshignore or .customignore (up to 32 names, 128 characters each). Use plain filenames, without paths, wildcards, reserved names or .gitignore/.ignore (use their toggles). Files use Git ignore syntax and load after .gitignore and .ignore in listed order. Later rules can negate earlier file exclusions; excluded parent directories are not scanned. Missing files are skipped.',
    ),
  nestedIgnoreFiles: Schema.boolean()
    .default(true)
    .description(
      'Apply ignore files in child directories relative to their own directory. Root rules always apply.',
    ),
  additionalExcludes: Schema.array(Schema.string())
    .default(['node_modules/'])
    .description(
      'Additional project-relative ignore rules, one per line. These only remove files admitted by project ignore rules. Git metadata is always excluded.',
    ),
  includeDotfiles: Schema.boolean()
    .default(false)
    .description(
      'Allow * and ** to match hidden files. Explicit hidden path components are supported either way.',
    ),
  caseSensitive: Schema.boolean()
    .default(process.platform !== 'win32')
    .description('Case sensitivity for glob and ignore matching.'),
  skipCodeBlocks: Schema.boolean()
    .default(true)
    .description(
      'Skip fenced code examples when finding patterns in messages. Inline backticks, @path references and ordinary path tokens are supported.',
    ),
  maxPatterns: Schema.number()
    .step(1)
    .min(1)
    .max(128)
    .default(32)
    .description('Maximum distinct patterns per message or preview.'),
  maxMatches: Schema.number()
    .step(1)
    .min(1)
    .max(100000)
    .default(2048)
    .description(
      'Maximum distinct matched files. An overflow fails visibly; file lists are never silently truncated.',
    ),
  maxScanEntries: Schema.number()
    .step(1)
    .min(100)
    .max(1000000)
    .default(50000)
    .description('Maximum visited directory entries, including excluded entries.'),
  maxDepth: Schema.number()
    .step(1)
    .min(1)
    .max(128)
    .default(48)
    .description('Maximum directory depth under the project root.'),
  maxResultBytes: Schema.number()
    .step(1)
    .min(1024)
    .max(4194304)
    .default(131072)
    .description('Maximum complete serialized expansion snapshot bytes.'),
  maxIgnoreBytes: Schema.number()
    .step(1)
    .min(1024)
    .max(1048576)
    .default(131072)
    .description('Aggregate ignore-file byte limit per scan.'),
  timeoutMs: Schema.number()
    .step(1)
    .min(100)
    .max(120000)
    .default(10000)
    .description('Deadline for root discovery and file enumeration.'),
})
export interface Policy {
  automatic: boolean
  commandEnabled: boolean
  rootMode: 'git' | 'workspace' | 'configured'
  projectRoot?: string
  honorIgnoreFiles: boolean
  respectGitignore: boolean
  respectIgnore: boolean
  additionalIgnoreFiles: string[]
  nestedIgnoreFiles: boolean
  additionalExcludes: string[]
  includeDotfiles: boolean
  caseSensitive: boolean
  skipCodeBlocks: boolean
  maxPatterns: number
  maxMatches: number
  maxScanEntries: number
  maxDepth: number
  maxResultBytes: number
  maxIgnoreBytes: number
  timeoutMs: number
}
export function resolvePolicy(input: Partial<Policy>): Policy {
  const policy = schema(input) as Policy
  if (policy.rootMode === 'configured' && !policy.projectRoot)
    throw new Error('Choose an absolute project root')
  if (
    policy.additionalExcludes.length > 256 ||
    policy.additionalExcludes.some((line) => line.length > 2048 || line.includes('\0'))
  )
    throw new Error('Additional exclusions exceed their bounds')
  return policy
}
