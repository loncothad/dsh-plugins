import { configEntry, editableConfig, managedApply } from '@loncothad/dsh-plugin-runtime'
/**
 * Model equivalence groups across providers: durable link table plus the
 * `/model-links`, `/model-link`, `/model-unlink`, and `/model-cycle`
 * commands. Cycling switches the harness default selection through the
 * same save path as the Models settings page; link edits persist through
 * the configuration editor when one is mounted.
 *
 * @module @loncothad/dsh-command-model-links
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'
import { mergeGroup, nextModel, parseLinkTable, serializeLinkTable, unlinkModel } from './groups.ts'

export * from './groups.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'command-model-links'

/** The command registry this plugin registers into. */
export const inject = ['commands', 'agentDefaultModel']

/** Plugin config: the durable equivalence groups. */
export interface Config {
  /** Semicolon-separated `model=model[=...]` groups; edited by `/model-link`. */
  readonly links: string
}

const BaseConfig = z.object({
  links: z
    .string()
    .default('')
    .description(
      'Groups of provider/model routes, separated by semicolons. Members within each group use =. Use the route picker below.',
    )
    .volatile(),
})

/** Read/write access to the durable link table. */
export interface LinkTableAccess {
  get(): string
  set(next: string): void | Promise<void>
}

/**
 * Register the four link commands against one link-table accessor.
 * `apply` wires the materialized volatile setting and the configuration
 * editor; tests inject a plain accessor.
 */
export function registerModelLinkCommands(ctx: Context, links: LinkTableAccess): void {
  const groups = (): readonly (readonly string[])[] => parseLinkTable(links.get())
  const saveGroups = async (next: readonly (readonly string[])[]): Promise<void> => {
    await links.set(serializeLinkTable(next))
  }
  const currentModel = (invocation: CommandInvocation): string => {
    const selected = invocation.agent.session
      .snapshotEvents()
      .findLast((event) => event.type === 'model/selection')
    const route =
      selected?.type === 'model/selection'
        ? selected.data
        : (invocation.agent.session.requestHeader()?.config ??
          ctx.agentDefaultModel.currentSelection())
    return `${route.provider}/${route.model}`
  }

  ctx.commands.register({
    name: 'model-links',
    description: 'Show the model equivalence groups',
    handler: () => {
      const table = groups()
      if (table.length === 0) {
        return {
          kind: 'success',
          text: 'No model links are configured. Use /model-link MODEL1=MODEL2 to create one.',
        }
      }
      return { kind: 'success', text: table.map((group) => `  ${group.join('  =  ')}`).join('\n') }
    },
  })

  ctx.commands.register({
    name: 'model-link',
    description: 'Declare that models across providers are the same logical model',
    input: { hint: 'MODEL1=MODEL2[=MODEL3...]' },
    handler: async (invocation) => {
      const members = invocation.rawInput
        .split('=')
        .map((part: string) => part.trim())
        .filter((part) => part.length > 0)
      if (new Set(members).size < 2) {
        return {
          kind: 'error',
          text: 'Usage: /model-link MODEL1=MODEL2[=...]; at least two distinct models.',
        }
      }
      if (members.some((member) => !/^([^/=;\s]+)\/([^=;\s]+)$/.test(member)))
        return {
          kind: 'error',
          text: 'Use provider/model routes, for example codex/gpt-6-luna=openrouter/openai/gpt-6-luna.',
        }
      await saveGroups(mergeGroup(groups(), members))
      return { kind: 'success', text: `Linked.\n${links.get()}` }
    },
  })

  ctx.commands.register({
    name: 'model-unlink',
    description: 'Remove a model from its link group',
    input: { hint: 'MODEL' },
    handler: async (invocation) => {
      const model = invocation.rawInput.trim()
      if (model.length === 0) return { kind: 'error', text: 'Usage: /model-unlink MODEL.' }
      const { groups: next, removed } = unlinkModel(groups(), model)
      if (!removed) return { kind: 'error', text: `${model} is not part of any link group.` }
      await saveGroups(next)
      return { kind: 'success', text: `Unlinked ${model}.` }
    },
  })

  ctx.commands.register({
    name: 'model-cycle',
    description: 'Switch to the next linked model',
    handler: async (invocation) => {
      const model = currentModel(invocation)
      const next = nextModel(groups(), model)
      if (next === undefined) {
        return {
          kind: 'error',
          text: `The model ${model} is not linked; use /model-link to link it.`,
        }
      }
      const slash = next.indexOf('/')
      if (slash < 1 || slash === next.length - 1)
        return { kind: 'error', text: 'Linked routes must use provider/model.' }
      const controller = ctx.get('sessionController')
      if (!controller)
        return { kind: 'error', text: 'Model cycling requires the native session controller.' }
      await controller.selectModel({
        sessionId: invocation.agent.session.id,
        provider: next.slice(0, slash),
        model: next.slice(slash + 1),
      })
      return { kind: 'success', text: `This conversation now uses ${next}.` }
    },
  })
}

/**
 * Persist one section edit through the mounted configuration editor.
 * Returns false when no editor or profile entry is available; callers
 * surface that as a settings-only warning.
 */
async function editSection(
  ctx: Context,
  next: () => Record<string, unknown>,
  expected: string,
): Promise<void> {
  const entry = configEntry(ctx),
    editor = ctx.get('configEditor')
  if (!entry || !editor) throw new Error('Model Links settings are not writable in this profile')
  await editor.edit(entry, (current, inherited) => {
    if (String(current.links ?? inherited.links ?? '') !== expected)
      throw new Error('Model links changed elsewhere. Reload before editing.')
    return { ...current, ...next() }
  })
}

/** Materialized volatile view of the plugin's section config. */
export interface MaterializedConfig {
  readonly links: { get(): string }
}

/** Register with the materialized volatile setting and editor-backed writes. */
function activate(ctx: Context, config: MaterializedConfig): void {
  registerModelLinkCommands(ctx, {
    get: () => config.links.get(),
    set: async (next) => {
      await editSection(ctx, () => ({ links: next }), config.links.get())
    },
  })
}

/** Complete configuration and managed capability lifetime. */
export const Config = editableConfig(BaseConfig)
export const apply = managedApply(BaseConfig, activate)
