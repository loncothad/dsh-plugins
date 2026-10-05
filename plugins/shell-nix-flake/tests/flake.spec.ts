import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createFlakeRule, findFlakeRoot } from '../src/index.ts'

it('detects the nearest flake and quotes the shell and original command independently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-flake-'))
  try {
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'flake.nix'), '{}')
    expect(await findFlakeRoot(join(root, 'src'))).toBe(root)
    const value = await createFlakeRule({ shell: 'checks' }).resolve(
      join(root, 'src'),
      "echo it's; pwd",
    )
    expect(value?.root).toBe(root)
    expect(value?.command).toContain('--no-write-lock-file')
    expect(value?.command).toContain(`#checks' --command bash -c 'echo it'\\''s; pwd'`)
    expect(await createFlakeRule({ mode: 'off' }).resolve(root, 'pwd')).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it('refuses forced mode without a flake and propagates cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-no-flake-'))
  try {
    await expect(createFlakeRule({ mode: 'on' }).resolve(root, 'pwd')).rejects.toThrow('flake')
    const signal = new AbortController()
    signal.abort()
    await expect(findFlakeRoot(root, signal.signal)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
