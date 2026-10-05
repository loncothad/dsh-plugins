/** Replace competing backends through public profile edits, without editing DSH's shipped presets. */
import { isDeepStrictEqual } from 'node:util'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { ConfigEditor } from '@deepseek-ai/dsh-config-editor'

export const EVIDENCE_RUNTIME = '@loncothad/dsh-evidence-compactor/runtime'
const STOCK = new Set([
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
  '@deepseek-ai/dsh-compaction-image-offload',
])
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface PresetReplacement {
  config: Record<string, unknown>
  changed: boolean
  backends: number
}

/** Keeps every unrelated row/config/expression; refuses ambiguous or unsupported ownership. */
export function replacePresetCompaction(config: Record<string, unknown>): PresetReplacement {
  if (!Array.isArray(config.plugins)) throw new Error('Agent preset has no plugin composition')
  let backends = 0
  const rewrite = (rows: unknown[], depth: number): EntryOptions[] => {
    if (depth > 16 || rows.length > 2048)
      throw new Error('Agent preset composition exceeds its bounds')
    return rows.flatMap((value) => {
      if (!record(value) || typeof value.name !== 'string' || typeof value.id !== 'string')
        throw new Error('Unsupported agent preset row')
      const row = structuredClone(value) as unknown as EntryOptions
      if (row.name === EVIDENCE_RUNTIME) {
        backends++
        return [row]
      }
      if (row.name === '@deepseek-ai/dsh-compaction-basic') {
        backends++
        // Retain native settings for operation when the evidence owner is disabled.
        const { disabled: _disabled, ...retained } = row
        return [{ ...retained, name: EVIDENCE_RUNTIME }]
      }
      if (STOCK.has(row.name)) return []
      if (row.name === 'cordis:group' || row.group === true) {
        if (!Array.isArray(row.config)) throw new Error('Unsupported agent preset group')
        row.config = rewrite(row.config, depth + 1)
      } else if (/compaction/i.test(row.name) && row.name !== '@deepseek-ai/dsh-command-compact') {
        throw new Error(`Unrecognized compaction owner: ${row.name}`)
      }
      return [row]
    })
  }
  const next = { ...structuredClone(config), plugins: rewrite(config.plugins, 0) }
  if (backends !== 1)
    throw new Error('Agent preset must contain exactly one supported compaction backend')
  return { config: next, changed: !isDeepStrictEqual(next, config), backends }
}

/** Validate every target before the first edit, then revalidate each current revision in edit(). */
export async function installPresetCompaction(
  editor: Pick<ConfigEditor, 'configuration' | 'edit'>,
  ids: readonly string[],
): Promise<string[]> {
  if (!ids.length || ids.length > 128 || new Set(ids).size !== ids.length)
    throw new Error('Invalid preset selection')
  const views = editor.configuration()
  const targets = ids.map((id) => {
    const matches = views.filter(
      (view) =>
        view.entry.options.id === id && view.entry.options.name === '@deepseek-ai/dsh-agent-preset',
    )
    if (matches.length !== 1) throw new Error(`Agent preset is unavailable: ${id}`)
    const entry = matches[0]!.entry
    if (!record(entry.options.config))
      throw new Error(`Agent preset configuration is unavailable: ${id}`)
    replacePresetCompaction(entry.options.config)
    return entry
  })
  const changed: string[] = []
  for (const entry of targets) {
    if (!replacePresetCompaction(entry.options.config as Record<string, unknown>).changed) continue
    await editor.edit(entry, (current) => replacePresetCompaction(current).config)
    changed.push(entry.options.id)
  }
  return changed
}
