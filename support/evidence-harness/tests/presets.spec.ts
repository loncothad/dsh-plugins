import type { ConfigEditor } from '@deepseek-ai/dsh-config-editor'
import { expect, it, vi } from 'vitest'
import { EVIDENCE_RUNTIME, installPresetCompaction, replacePresetCompaction } from '../src/index.ts'

const preset = () => ({
  id: 'standard',
  plugins: [
    {
      id: 'tool-bash',
      name: '@deepseek-ai/dsh-tool-bash',
      disabled: "process.platform === 'win32'",
      config: { environment: 'kept' },
    },
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        {
          id: 'compaction-basic',
          name: '@deepseek-ai/dsh-compaction-basic',
          config: { retainRatio: 0.3 },
        },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        { id: 'pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner' },
        { id: 'images', name: '@deepseek-ai/dsh-compaction-image-offload' },
      ],
    },
  ],
})

it('replaces one backend, removes competing mutations, and retains other composition and expressions', () => {
  const original = preset()
  const result = replacePresetCompaction(original)
  expect(result.changed).toBe(true)
  expect((result.config.plugins as unknown[])[0]).toEqual(original.plugins[0])
  expect((result.config.plugins as { config?: unknown }[])[1]?.config).toEqual([
    { id: 'compaction-basic', name: EVIDENCE_RUNTIME, config: { retainRatio: 0.3 } },
    { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
  ])
  expect(original.plugins[1]?.config).toHaveLength(4)
  expect(replacePresetCompaction(result.config).changed).toBe(false)
})

it('refuses missing, duplicate, and unsupported compaction owners', () => {
  expect(() => replacePresetCompaction({ plugins: [] })).toThrow('exactly one')
  expect(() =>
    replacePresetCompaction({
      plugins: [
        { id: 'a', name: EVIDENCE_RUNTIME },
        { id: 'b', name: EVIDENCE_RUNTIME },
      ],
    }),
  ).toThrow('exactly one')
  expect(() =>
    replacePresetCompaction({ plugins: [{ id: 'x', name: 'third-party-compaction' }] }),
  ).toThrow('Unrecognized')
  expect(() =>
    replacePresetCompaction({ plugins: [{ id: 'group', name: 'cordis:group', config: '{}' }] }),
  ).toThrow('group')
})

it('preflights every target before writes and revalidates current configuration inside the native edit', async () => {
  const entry = {
    options: { id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config: preset() },
  }
  const edit = vi.fn(async (_entry, change) => {
    entry.options.config = change(entry.options.config, {})
  })
  const editor = { configuration: () => [{ entry }], edit } as unknown as Pick<
    ConfigEditor,
    'configuration' | 'edit'
  >
  await expect(installPresetCompaction(editor, ['preset-standard', 'missing'])).rejects.toThrow(
    'unavailable',
  )
  expect(edit).not.toHaveBeenCalled()
  expect(await installPresetCompaction(editor, ['preset-standard'])).toEqual(['preset-standard'])
  expect(await installPresetCompaction(editor, ['preset-standard'])).toEqual([])
  expect(edit).toHaveBeenCalledTimes(1)
})
