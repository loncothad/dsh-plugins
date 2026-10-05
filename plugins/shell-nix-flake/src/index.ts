import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  editableConfig,
  managedApply,
  registerShellRule,
  type ShellBudgets,
  type ShellRule,
} from '@loncothad/dsh-plugin-runtime'
export const name = 'shell-nix-flake'
export const inject = ['subprocess', 'sandbox', 'sandboxPolicy']
const schema = z.object({
  mode: z.union(['auto', 'on', 'off']).default('auto'),
  shell: z
    .string()
    .default('default')
    .pattern(/^[a-zA-Z0-9_-]{1,128}$/)
    .description('Named devShell output. default selects the current system default.'),
  flakeRoot: z
    .string()
    .description(
      'Optional absolute flake root. Otherwise detect the nearest flake.nix above the conversation directory.',
    ),
  nixExecutable: z.string().default('nix').description('Nix executable on the Harness host.'),
  bash: z.object({
    cwd: z.string(),
    timeoutMs: z.number().step(1).min(1).max(86400000),
    maxTimeoutMs: z.number().step(1).min(1).max(86400000),
    maxOutputBytes: z.number().step(1).min(1).max(67108864),
    maxSpillBytes: z.number().step(1).min(1).max(1073741824),
    graceMs: z.number().step(1).min(1).max(60000),
  }),
})
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
export async function findFlakeRoot(
  workdir: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let path = resolve(workdir)
  for (let depth = 0; depth < 128; depth++) {
    signal?.throwIfAborted()
    try {
      if ((await stat(resolve(path, 'flake.nix'))).isFile()) return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(path)
    if (parent === path) return undefined
    path = parent
  }
  throw new Error('Flake detection exceeded its depth limit')
}
export function createFlakeRule(config: {
  mode?: 'auto' | 'on' | 'off'
  shell?: string
  flakeRoot?: string
  nixExecutable?: string
  bash?: ShellBudgets
}): ShellRule {
  return {
    id: 'nix-flake',
    priority: 50,
    budgets: config.bash ?? {},
    resolve: async (workdir, command, signal) => {
      if (config.mode === 'off') return undefined
      signal?.throwIfAborted()
      const root = config.flakeRoot ?? (await findFlakeRoot(workdir, signal))
      if (!root) {
        if (config.mode === 'on')
          throw new Error('Select a flake project before forcing Nix Flake Shell')
        return undefined
      }
      const target = `path:${resolve(root)}#${config.shell ?? 'default'}`
      return {
        root: resolve(root),
        command: `${quote(config.nixExecutable ?? 'nix')} --extra-experimental-features 'nix-command flakes' develop --no-write-lock-file ${quote(target)} --command bash -c ${quote(command)}`,
      }
    },
  }
}
async function activate(ctx: Context, config: ReturnType<typeof schema>): Promise<void> {
  if (config.flakeRoot && !isAbsolute(config.flakeRoot))
    throw new Error('Configured flake root must be absolute')
  if (process.platform === 'win32')
    throw new Error('Nix Flake Shell requires a POSIX host. Run DSH in WSL on Windows.')
  await registerShellRule(ctx, createFlakeRule(config))
}
export const Config = editableConfig(schema)
export const apply = managedApply(schema, activate)
