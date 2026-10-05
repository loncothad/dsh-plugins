/**
 * The codex model-behavior commands — `/codex-speed`, `/daybreak`, and
 * `/codex-image` — mounted only while the default model selection points
 * at this provider's route, so they never clutter the palette when other
 * models are in use. The commands seam has no per-command visibility
 * predicate, but registration returns a disposer and UIs re-list on
 * `commands/change`; a low-frequency reconcile over the default-model
 * getters (plain snapshots, not reactive) keeps the mounted set in step
 * with the selection. The account management commands stay available:
 * they must be reachable
 * before any codex model is ever selected.
 *
 * @module @loncothad/dsh-provider-openai-codex/model-commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { CodexImageToolOptions } from './skill.ts'
import { runCodexImageCommand } from './skill.ts'
import type { SpeedAccess, SpeedName } from './speed.ts'
import { SPEED_NAMES } from './speed.ts'

/** The provider routes whose models these commands configure (standard + Daybreak). */
export const CODEX_PROVIDERS = ['codex', 'codex-daybreak'] as const

/** How often the mounted set reconciles against the default selection. */
export const RECONCILE_MS = 2_000

/** Model-group registration options. */
export interface CodexModelCommandsOptions {
  /** Speed-layer access; omit to skip `/codex-speed`. */
  readonly speed?: SpeedAccess
  /** Image generation options; omit to skip `/codex-image`. */
  readonly image?: CodexImageToolOptions
  /** Resolves the active default provider; defaults to the selection service. */
  readonly activeProvider?: () => string | undefined
  /** Reconcile interval override for tests. */
  readonly reconcileMs?: number
}

/**
 * Mount the codex model commands while the default selection points at a
 * codex route (standard or Daybreak), unmounting otherwise. A missing
 * selection service keeps the commands mounted — an undeterminable
 * context hides nothing.
 */
export function registerCodexModelCommands(ctx: Context, options: CodexModelCommandsOptions): void {
  const activeProvider =
    options.activeProvider ?? (() => ctx.get('agentDefaultModel')?.currentSelection().provider)
  let dispose: (() => void) | undefined

  const reconcile = () => {
    const provider = activeProvider()
    const active =
      provider === undefined || (CODEX_PROVIDERS as readonly string[]).includes(provider!)
    if (active && dispose === undefined) {
      dispose = mount(ctx, options)
    } else if (!active && dispose !== undefined) {
      dispose()
      dispose = undefined
    }
  }
  reconcile()
  // A plain interval with effect-managed cleanup: the commands seam has
  // no selection-change event, and the host's timer service is optional.
  ctx.effect(() => {
    const timer = setInterval(reconcile, options.reconcileMs ?? RECONCILE_MS)
    return () => clearInterval(timer)
  })
}

/** Register the whole model group; returns the group disposer. */
function mount(ctx: Context, options: CodexModelCommandsOptions): () => void {
  const disposers: Array<() => void> = []
  if (options.speed !== undefined) {
    disposers.push(registerSpeedCommands(ctx, options.speed))
  }
  if (options.image !== undefined) {
    disposers.push(registerImageCommand(ctx, options.image))
  }
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** `/codex-speed` over the speed access. Daybreak is not a speed: it is
 * the `codex-daybreak` provider route (a cyber access program), toggled
 * by selecting that group in the model window. */
function registerSpeedCommands(ctx: Context, speed: SpeedAccess): () => void {
  const disposeSpeed = ctx.commands.register({
    name: 'codex-speed',
    description: 'Show or set the processing speed layered onto Codex requests',
    input: { hint: '[standard|fast|ultrafast]' },
    handler: async (invocation): Promise<CommandResult> => {
      const argument = invocation.rawInput.trim().toLowerCase()
      if (argument.length === 0) {
        return {
          kind: 'success',
          text:
            `Codex speed: ${speed.speed()}` +
            '\nModels that do not advertise a tier keep standard routing.',
        }
      }
      if (!(SPEED_NAMES as readonly string[]).includes(argument)) {
        return { kind: 'error', text: `Usage: /codex-speed [${SPEED_NAMES.join('|')}].` }
      }
      const next = argument as SpeedName
      speed.setSpeed(next)
      return { kind: 'success', text: `Codex speed is now ${next}.` }
    },
  })
  return disposeSpeed
}

/** `/codex-image` over the shared image executor. */
function registerImageCommand(ctx: Context, image: CodexImageToolOptions): () => void {
  return ctx.commands.register({
    name: 'codex-image',
    description: 'Generate one image with the ChatGPT subscription',
    input: { hint: '<prompt>' },
    handler: async (invocation): Promise<CommandResult> => {
      const prompt = invocation.rawInput.trim()
      if (prompt.length === 0) {
        return { kind: 'error', text: 'Usage: /codex-image <prompt>.' }
      }
      const outcome = await runCodexImageCommand(image, prompt, invocation.signal, invocation.agent)
      if (outcome.error !== undefined) {
        return { kind: 'error', text: outcome.error }
      }
      return {
        kind: 'success',
        text: `Image written to ${outcome.path}`,
      }
    },
  })
}
