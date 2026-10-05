import {
  editableConfig,
  managedApply,
  registerShellRule,
  type ShellRule,
} from '@loncothad/dsh-plugin-runtime'
/**
 * Devenv.sh shell wrapping: a `SandboxBashExecutor` subclass that rewrites
 * commands into the project's dev shell (`devenv shell -c '...'`) when the
 * command's working directory belongs to a project declaring devenv.sh
 * (`devenv.nix` / `devenv.yaml` at or above it).
 *
 * Mount this bundle INSTEAD of `bash-sandbox`: it registers the same `shell`
 * service, delegating spawn, environment layering, output collection, and
 * deadlines to the inherited executor.
 *
 * @module @loncothad/dsh-shell-devenv
 */

import { readdir, stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { type DevenvIo, expandWrapper, findDevenvRoot } from './devenv.ts'

export type { DevenvIo } from './devenv.ts'
export {
  DEVENV_MARKERS,
  expandWrapper,
  findDevenvRoot,
  quoteCommand,
  wrappingApplies,
} from './devenv.ts'

/** Default dev-shell entry pattern. */
export const DEFAULT_DEVENV_TEMPLATE = 'devenv shell -c {command}'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'shell-devenv'

/** The seam this executor replaces. */
export const inject = ['subprocess', 'sandbox', 'sandboxPolicy']

/** Plugin config: devenv wrapping plus the inherited bash-local budgets. */
export interface Config {
  /** `auto` wraps only detected devenv projects; `on` always; `off` never. */
  mode?: 'auto' | 'on' | 'off'
  /** Wrapper command template. */
  wrapper?: string
  /** Filesystem surface for tests. */
  io?: DevenvIo
  /** Inherited bash-local defaults, overridable. */
  bash?: BashBudgets
}

/** The six budgets `SandboxBashExecutor` reads; defaults mirror its schema. */
export interface BashBudgets {
  cwd?: string
  timeoutMs?: number
  maxTimeoutMs?: number
  maxOutputBytes?: number
  maxSpillBytes?: number
  graceMs?: number
}

const BaseConfig = z.object({
  mode: z.union(['auto', 'on', 'off'] as const),
  wrapper: z.string(),
  bash: z.object({
    cwd: z.string(),
    timeoutMs: z.number().step(1).min(1).max(86400000),
    maxTimeoutMs: z.number().step(1).min(1).max(86400000),
    maxOutputBytes: z.number().step(1).min(1).max(67108864),
    maxSpillBytes: z.number().step(1).min(1).max(1073741824),
    graceMs: z.number().step(1).min(0).max(60000),
  }),
})

const defaultIo: DevenvIo = {
  readdir: async (path) => readdir(path),
  accessible: async (path) => {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  },
}

export function createDevenvRule(
  budgets: BashBudgets,
  config: { mode: 'auto' | 'on' | 'off'; wrapper: string; io?: DevenvIo },
): ShellRule {
  const io = config.io ?? defaultIo
  return {
    id: 'devenv',
    priority: 100,
    budgets,
    resolve: async (workdir, command, signal) => {
      signal?.throwIfAborted()
      if (config.mode === 'off') return undefined
      const root = await findDevenvRoot(workdir, io)
      signal?.throwIfAborted()
      if (config.mode === 'auto' && !root) return undefined
      return { root: root ?? workdir, command: expandWrapper(config.wrapper, command) }
    },
  }
}
async function activate(ctx: Context, config: Config): Promise<void> {
  if (process.platform === 'win32')
    throw new Error('Devenv Shell requires a POSIX host. Run DSH in WSL on Windows.')
  await registerShellRule(
    ctx,
    createDevenvRule(config.bash ?? {}, {
      mode: config.mode ?? 'auto',
      wrapper: config.wrapper ?? DEFAULT_DEVENV_TEMPLATE,
    }),
  )
}

/** Complete configuration and managed capability lifetime. */
export const Config = editableConfig(BaseConfig)
export const apply = managedApply(BaseConfig, activate)
