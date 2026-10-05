import { fingerprint } from '@loncothad/dsh-execution-core'

type Row = Record<string, unknown>
export interface PresetRow {
  path: string
  module: string
  label: string
  ownDisabled: boolean
  conditional: boolean
  parentDisabled: boolean
}
export function presetRows(plugins: unknown): PresetRow[] {
  const found: PresetRow[] = []
  let visited = 0
  const walk = (rows: unknown, prefix: number[], parentDisabled: boolean) => {
    if (!Array.isArray(rows) || rows.length > 512 || prefix.length > 8)
      throw Error('Preset composition exceeds the control bounds')
    rows.forEach((value, index) => {
      if (++visited > 2048) throw Error('Preset traversal exceeds 2048 entries')
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('Invalid preset row')
      const row = value as Row,
        path = [...prefix, index],
        conditional = Boolean(row.disabled && typeof row.disabled === 'object')
      if (row.group === true)
        walk(row.config, path, parentDisabled || row.disabled === true || conditional)
      else if (typeof row.name === 'string') {
        if (found.length >= 512) throw Error('Too many preset components')
        found.push({
          path: path.join('.'),
          module: row.name,
          label: typeof row.id === 'string' ? row.id : row.name,
          ownDisabled: row.disabled === true,
          conditional,
          parentDisabled,
        })
      }
    })
  }
  walk(plugins, [], false)
  return found
}
function rowAt(config: Row, path: string): Row {
  if (!/^\d+(?:\.\d+){0,7}$/.test(path)) throw Error('Invalid component path')
  let rows = config.plugins
  const indices = path.split('.').map(Number)
  let result: Row | undefined
  for (const index of indices) {
    if (!Array.isArray(rows) || !Number.isSafeInteger(index) || index < 0 || index >= rows.length)
      throw Error('Component is no longer available')
    result = rows[index] as Row
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw Error('Invalid component')
    rows = result.config
  }
  if (result?.group === true || typeof result?.name !== 'string')
    throw Error('Select a component, not a preset group')
  return result
}
export function changePreset(
  current: Row,
  inherited: Row,
  path: string,
  mode: 'on' | 'off' | 'default',
  revision: string,
): Row {
  if (fingerprint(current) !== revision) throw Error('Preset changed elsewhere. Refresh first.')
  const next = structuredClone(current),
    row = rowAt(next, path)
  if (mode === 'default') {
    const original = rowAt(inherited, path)
    if (original.id !== row.id || original.name !== row.name)
      throw Error('Inherited component differs. Restore it through the preset configuration.')
    if (Object.hasOwn(original, 'disabled')) row.disabled = structuredClone(original.disabled)
    else delete row.disabled
  } else row.disabled = mode === 'off'
  return next
}
