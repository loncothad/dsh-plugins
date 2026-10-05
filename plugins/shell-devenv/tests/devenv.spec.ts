import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandWrapper, findDevenvRoot, quoteCommand, wrappingApplies } from '../src/devenv.ts'
import { createDevenvRule, DEFAULT_DEVENV_TEMPLATE } from '../src/index.ts'

const fakeIo = (files: Set<string>) => ({
  readdir: async () => [],
  accessible: async (path: string) => files.has(path),
})
describe('Devenv project routing', () => {
  it('finds nearest project markers and stops at the root', async () => {
    expect(await findDevenvRoot('/w/project/src', fakeIo(new Set(['/w/project/devenv.nix'])))).toBe(
      '/w/project',
    )
    expect(await findDevenvRoot('/w/plain', fakeIo(new Set()))).toBeUndefined()
  })
  it('quotes a literal shell command and template correctly', () => {
    expect(quoteCommand("echo it's")).toBe("'echo it'\\''s'")
    expect(expandWrapper(DEFAULT_DEVENV_TEMPLATE, 'make test')).toBe("devenv shell -c 'make test'")
    expect(wrappingApplies('off', true)).toBe(false)
  })
  it('honors modes and rechecks changes to project markers', async () => {
    const files = new Set(['/w/project/devenv.nix']),
      rule = createDevenvRule(
        {},
        { mode: 'auto', wrapper: DEFAULT_DEVENV_TEMPLATE, io: fakeIo(files) },
      )
    expect(await rule.resolve('/w/project/src', 'ls')).toMatchObject({
      root: '/w/project',
      command: "devenv shell -c 'ls'",
    })
    files.clear()
    expect(await rule.resolve('/w/project/src', 'ls')).toBeUndefined()
    expect(
      await createDevenvRule(
        {},
        { mode: 'on', wrapper: DEFAULT_DEVENV_TEMPLATE, io: fakeIo(files) },
      ).resolve('/w/project', 'ls'),
    ).toMatchObject({ root: '/w/project' })
    expect(
      await createDevenvRule(
        {},
        { mode: 'off', wrapper: DEFAULT_DEVENV_TEMPLATE, io: fakeIo(files) },
      ).resolve('/w/project', 'ls'),
    ).toBeUndefined()
  })
  it('reads actual nested project markers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-devenv-'))
    try {
      await mkdir(join(root, 'src'))
      await writeFile(join(root, 'devenv.yaml'), '{}')
      const rule = createDevenvRule({}, { mode: 'auto', wrapper: DEFAULT_DEVENV_TEMPLATE })
      expect(await rule.resolve(join(root, 'src'), 'echo hello')).toMatchObject({
        root,
        command: "devenv shell -c 'echo hello'",
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
