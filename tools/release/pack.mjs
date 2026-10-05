/** Pack coordinated artifacts into a fresh directory. No registry writes. */

import { spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pnpm = process.env.PNPM_EXECUTABLE ?? process.env.npm_execpath ?? 'pnpm',
  script = /^\.(?:cjs|mjs|js)$/i.test(extname(pnpm))
if (process.platform === 'win32' && !script && !pnpm.endsWith('.exe'))
  throw Error(
    'Run pnpm pack:release DIRECTORY on Windows so the package-manager CLI is passed directly to Node.',
  )
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  directory = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Usage: node tools/release/pack.mjs EMPTY_ARTIFACT_DIRECTORY')
await mkdir(directory, { recursive: true })
if ((await readdir(directory)).length) throw new Error('Artifact directory must be empty')
for (const group of ['support', 'plugins'])
  for (const entry of (await readdir(join(root, group))).sort()) {
    const cwd = join(root, group, entry),
      manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
    const result = spawnSync(
      script ? process.execPath : pnpm,
      [...(script ? [pnpm] : []), 'pack', '--pack-destination', directory],
      { cwd, encoding: 'utf8' },
    )
    if (result.status !== 0)
      throw new Error(
        `${manifest.name}: packing failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
      )
    console.log(`Packed ${manifest.name}@${manifest.version}`)
  }
