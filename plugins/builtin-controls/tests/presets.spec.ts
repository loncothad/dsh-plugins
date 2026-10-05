import { fingerprint } from '@loncothad/dsh-execution-core'
import { expect, it } from 'vitest'
import { changePreset, presetRows } from '../src/presets.ts'
import { disabledSkillsSchema } from '../src/skill-selection.ts'

const original = {
  id: 'standard',
  name: 'Standard',
  unrelated: 'preserve',
  plugins: [
    { id: 'fs', name: '@deepseek-ai/dsh-tool-fs', config: { permission: 'native' } },
    {
      id: 'planning',
      name: 'cordis:group',
      group: true,
      config: [
        {
          id: 'skill',
          name: '@deepseek-ai/dsh-tool-skill',
          disabled: { __jsExpr: "process.platform === 'win32'" },
        },
      ],
    },
  ],
}
it('toggles only the selected nested component and restores its inherited condition', () => {
  const before = structuredClone(original),
    next = changePreset(before, original, '1.0', 'off', fingerprint(before))
  expect(before).toEqual(original)
  expect(presetRows(next.plugins).map((r) => r.ownDisabled)).toEqual([false, true])
  expect((next.plugins as unknown[])[0]).toEqual(original.plugins[0])
  expect(next.unrelated).toBe('preserve')
  expect(changePreset(next, original, '1.0', 'default', fingerprint(next))).toEqual(original)
})
it('rejects stale saves, structural groups, invalid paths and changed inherited identities', () => {
  expect(() => changePreset(original, original, '0', 'off', 'stale')).toThrow('changed elsewhere')
  for (const path of ['1', '99', '-1', '0.__proto__', '1.0.0'])
    expect(() => changePreset(original, original, path, 'off', fingerprint(original))).toThrow()
  const different = {
    ...original,
    plugins: [{ id: 'different', name: '@deepseek-ai/dsh-tool-bash' }],
  }
  expect(() => changePreset(original, different, '0', 'default', fingerprint(original))).toThrow(
    'differs',
  )
})
it('reports disabled parent groups and bounds the composition', () => {
  const rows = [{ group: true, disabled: true, config: [{ id: 'child', name: 'plugin' }] }]
  expect(presetRows(rows)[0].parentDisabled).toBe(true)
  expect(() => presetRows(Array.from({ length: 513 }, () => ({ name: 'plugin' })))).toThrow(
    'bounds',
  )
  expect(() =>
    presetRows(
      Array.from({ length: 512 }, () => ({
        group: true,
        config: Array.from({ length: 4 }, () => ({ group: true, config: [] })),
      })),
    ),
  ).toThrow('2048')
})
it('validates and deduplicates exact skill names', () => {
  expect(disabledSkillsSchema.parse(['z-skill', 'a-skill', 'a-skill'])).toEqual([
    'a-skill',
    'z-skill',
  ])
  expect(() => disabledSkillsSchema.parse(['../skill'])).toThrow()
  expect(() => disabledSkillsSchema.parse(Array.from({ length: 513 }, () => 'skill'))).toThrow()
})
