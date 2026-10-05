import { editableConfig, managedApply } from '@loncothad/dsh-plugin-runtime'
/**
 * Replace dsh's system prompt wholesale. The system-prompt seam is built
 * for this: a section registered with `complete: true` is restored after
 * assembly as the sole prompt section — the harness identity, deployment
 * persona, and every first-party guidance section are dropped, while the
 * assembly waterfall still resolves tools, contexts, and variables. The
 * replacement text may reference registered `{{variable}}`s (strict).
 *
 * The prompt comes from exactly one source: an inline config string or a
 * file (read at registration; a deployment reload re-resolves it).
 *
 * @module @loncothad/dsh-system-prompt-replace
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'
import type { PromptIo, ResolvedPrompt } from './prompt.ts'
import { resolvePrompt } from './prompt.ts'

export * from './prompt.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'system-prompt-replace'

/** The seams this plugin registers into. */
export const inject = ['systemPrompt', 'commands']

/** Plugin config. */
export interface Config {
  /** The complete replacement prompt, inline. Exclusive with `file`. */
  prompt?: string
  /** Path to the complete replacement prompt file. Exclusive with `prompt`. */
  file?: string
  /** Interpolate `{{variable}}` references (default true; false keeps literal text). */
  interpolate?: boolean
  /** Also suppress dynamic runtime-context snapshots (default false). */
  suppressRuntimeContext?: boolean
}

const BaseConfig = z.object({
  prompt: z.string(),
  file: z.string(),
  interpolate: z.boolean().default(true),
  suppressRuntimeContext: z.boolean().default(false),
})

/** Deterministic hooks for tests. */
export interface ReplaceInternals {
  io?: PromptIo
}

/**
 * Register the replacement section. `complete: true` makes the
 * system-prompt seam restore exactly this section after assembly,
 * replacing the built-in prompt entirely.
 */
export function registerReplacement(
  ctx: Context,
  options: {
    resolved: ResolvedPrompt
    interpolate: boolean
  },
): void {
  ctx.systemPrompt.section({
    name: 'system-prompt-replace:complete',
    order: 0,
    complete: true,
    text: options.resolved.text,
    ...(options.interpolate ? {} : { interpolate: false }),
  })
}

/** Register with schema-resolved config and the status command. */
function activate(ctx: Context, config: Config, internals: ReplaceInternals = {}): void {
  let resolved: ResolvedPrompt | undefined
  ctx.commands.register({
    name: 'system-prompt',
    description: 'Show the configured replacement system prompt',
    handler: async (): Promise<CommandResult> => {
      if (!resolved)
        return {
          kind: 'success',
          text: 'No replacement is active. Configure text or a file in Plugins > System Prompt Replace.',
        }
      const preview = resolved.text.length > 400 ? `${resolved.text.slice(0, 400)}…` : resolved.text
      return {
        kind: 'success',
        text: `The system prompt is replaced (${resolved.source}, ${resolved.text.length} chars, ${config.interpolate === false ? 'literal' : 'variables interpolated'}, ${config.suppressRuntimeContext === true ? 'runtime context suppressed' : 'runtime context kept'}).\n\n${preview}`,
      }
    },
  })
  try {
    resolved =
      internals.io !== undefined ? resolvePrompt(config, internals.io) : resolvePrompt(config)
  } catch (error: unknown) {
    // An unconfigured deployment keeps the built-in prompt: warn and mount
    // nothing rather than crash the tree.
    ctx.logger.warn(`system-prompt-replace: not active (${String(error)})`)
    return
  }
  registerReplacement(ctx, {
    resolved,
    interpolate: config.interpolate ?? true,
  })
  if (config.suppressRuntimeContext === true) {
    ctx.systemPrompt.suppressRuntimeContext()
  }
}

/** Complete configuration and managed capability lifetime. */
export const Config = editableConfig(BaseConfig)
export const apply = managedApply(BaseConfig, activate)
