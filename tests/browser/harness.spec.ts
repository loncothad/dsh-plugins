import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fixtureLog } from './harness.mjs'

it('rejects an unmarked profile, a different profile identity and a startup log outside the fixture home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-guard-')),
    home = join(root, 'dev'),
    profile = join(home, 'profiles/web'),
    log = join(home, 'web.log'),
    outside = join(root, 'other.log')
  try {
    await mkdir(profile, { recursive: true })
    await writeFile(
      join(profile, 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles: ['qualification-fixture'] } } }),
    )
    await writeFile(log, 'Private test startup log')
    await writeFile(outside, 'Unrelated profile log')
    await expect(fixtureLog({ profile, log })).rejects.toThrow()
    const marker = join(profile, '.dsh-browser-fixture.json')
    await writeFile(marker, JSON.stringify({ version: 1, profile: root }))
    await expect(fixtureLog({ profile, log })).rejects.toThrow('not a marked')
    await writeFile(marker, JSON.stringify({ version: 1, profile: await realpath(profile) }))
    await expect(fixtureLog({ profile, log: outside })).rejects.toThrow('selected fixture home')
    expect(await fixtureLog({ profile, log })).toBe('Private test startup log')
    await writeFile(
      join(profile, 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles: [] } } }),
    )
    await expect(fixtureLog({ profile, log })).rejects.toThrow('not a marked')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
