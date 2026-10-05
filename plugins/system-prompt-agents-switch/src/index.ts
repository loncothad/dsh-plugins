import { configEntry, editableConfig, managedApply } from '@loncothad/dsh-plugin-runtime'

/**
 * Per-provider/model superprompt switching: a system-prompt section that
 * injects the mapped instruction file for the current default model
 * selection, plus the `/agents-file` command managing the mapping.
 *
 * The harness's own `agent-instructions` plugin already reads AGENTS.md;
 * this plugin adds files for designators mapped AWAY from that default.
 * The mapping is durable and volatile; edits apply to the next assembly.
 *
 * @module @loncothad/dsh-system-prompt-agents-switch
 */

import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'
import {
  BUILTIN,
  clearMapping,
  fileFor,
  parseMapping,
  serializeMapping,
  setMapping,
} from './mapping.ts'

export * from './mapping.ts'

/** Section order: reusable instructions follow first-party guidance. */
const SECTION_ORDER = 900

/** Characters of one mapped file injected per assembly. */
const INSTRUCTION_LIMIT = 16_000

/** Cordis plugin name used by loader diagnostics. */
export const name = 'system-prompt-agents-switch'

/** The seams this plugin registers into. */
export const inject = ['systemPrompt', 'commands']

/** Plugin config. */
export interface Config {
  /** Semicolon-joined `designator=file` mappings; edited by `/agents-file`. */
  map: Volatile<string>
  /** Default file for unmapped designators (the built-in reader covers it). */
  defaultFile: Volatile<string>
}

const BaseConfig = z.object({
  map: z
    .string()
    .default('')
    .description('provider/model=instruction-file mappings, separated by semicolons.')
    .volatile(),
  defaultFile: z
    .string()
    .default(BUILTIN())
    .description(
      'Fallback instruction file. AGENTS.md is already read by DSH; custom files are appended once per request.',
    )
    .volatile(),
})

/** Read/write access to the mapping settings (the volatile materialization). */
export interface SwitchAccess {
  map(): string
  defaultFile(): string
  setMap(next: string): void | Promise<void>
}

/**
 * Wire the system-prompt section and the command against one mapping
 * accessor. `apply` delegates here with the materialized volatiles; tests
 * inject a plain accessor.
 */
export function registerAgentsSwitch(ctx: Context, access: SwitchAccess): void {
  const entries = () => parseMapping(access.map())
  const designator = (agent?: Agent): { designator: string; model: string | undefined } => {
    const selected = agent?.session
      .snapshotEvents()
      .findLast((event) => event.type === 'model/selection')
    const route =
      selected?.type === 'model/selection'
        ? selected.data
        : (agent?.session.requestHeader()?.config ??
          ctx.get('agentDefaultModel')?.currentSelection())
    return {
      designator: `${route?.provider ?? 'provider'}/${route?.model ?? 'model'}`,
      model: route?.model,
    }
  }
  const readInstructions = async (file: string, cwd: string, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const path = resolve(cwd, file),
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > INSTRUCTION_LIMIT * 4)
        throw new Error('Instruction file must be a regular file under 64 KiB')
      const bytes = Buffer.alloc(info.size + 1),
        { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead !== info.size) throw new Error('Instruction file changed while reading')
      signal?.throwIfAborted()
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
      if (text.length > INSTRUCTION_LIMIT)
        throw new Error('Instruction file exceeds 16000 characters')
      return text
    } finally {
      await handle.close()
    }
  }
  ctx.on(
    'system-prompt/assemble',
    async (_assembly, context, next) => {
      const assembly = await next(),
        id = designator(context.agent),
        provider = assembly.variables.provider,
        model = assembly.variables.model
      const file = fileFor(
        entries(),
        provider && model ? `${provider}/${model}` : id.designator,
        model ?? id.model,
        access.defaultFile(),
      )
      if (file === BUILTIN()) return assembly
      const text = await readInstructions(
        file,
        context.agent?.session.header.cwd ?? process.cwd(),
        context.signal,
      )
      return {
        ...assembly,
        sections: [
          ...assembly.sections,
          {
            name: 'agents-switch:superprompt',
            order: SECTION_ORDER,
            text: `From ${file}:\n\n${text}`,
            interpolate: false,
          },
        ],
      }
    },
    { prepend: true },
  )
  const commitMap = async (next: string) => {
    await access.setMap(next)
  }

  ctx.commands.register({
    name: 'agents-file',
    description: 'Show or set the superprompt file for the active provider/model',
    input: { hint: 'status|FILE|clear' },
    handler: async (invocation): Promise<CommandResult> => {
      const argument = invocation.rawInput.trim()
      const { designator: id } = designator(invocation.agent)
      if (argument.length === 0 || argument.toLowerCase() === 'status') {
        const table = entries()
        const mapped = table.map((entry) => `${entry.designator}=${entry.file}`).join('\n')
        return {
          kind: 'success',
          text:
            `Superprompt file for ${id}: ${fileFor(table, id, designator(invocation.agent).model, access.defaultFile())}` +
            (table.length > 0 ? `\nMappings:\n${mapped}` : '\nNo custom mappings.'),
        }
      }
      if (argument.toLowerCase() === 'clear') {
        const { entries: next, removed } = clearMapping(entries(), id)
        if (!removed) {
          return { kind: 'error', text: `The active designator ${id} has no mapping.` }
        }
        await commitMap(serializeMapping(next))
        return { kind: 'success', text: `Removed the mapping for ${id}.` }
      }
      await readInstructions(
        argument,
        invocation.agent.session.header.cwd ?? process.cwd(),
        invocation.signal,
      )
      await commitMap(serializeMapping(setMapping(entries(), id, argument)))
      return { kind: 'success', text: `Superprompt file for ${id} set to ${argument}.` }
    },
  })
}

/** Materialized volatile view of the plugin's section config. */
export interface MaterializedConfig {
  readonly map: { get(): string }
  readonly defaultFile: { get(): string }
}

/** Register with the materialized volatile setting and editor-backed writes. */
function activate(ctx: Context, config: MaterializedConfig): void {
  registerAgentsSwitch(ctx, {
    map: () => config.map.get(),
    defaultFile: () => config.defaultFile.get(),
    setMap: async (next) => {
      const entry = configEntry(ctx),
        editor = ctx.get('configEditor')
      if (!entry || !editor)
        throw new Error('Agents Switch settings are not writable in this profile')
      const expected = config.map.get()
      await editor.edit(entry, (current, inherited) => {
        if (String(current.map ?? inherited.map ?? '') !== expected)
          throw new Error('Instruction mappings changed elsewhere. Reload before editing.')
        return { ...current, map: next, defaultFile: config.defaultFile.get() }
      })
    },
  })
}

/** Complete configuration and managed capability lifetime. */
export const Config = editableConfig(BaseConfig)
export const apply = managedApply(BaseConfig, activate)
