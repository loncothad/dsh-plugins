/** Install a temporary no-network fixture only after real profile dependencies are installed. */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

if (!process.argv[2]) throw new Error('Pass an explicit temporary DSH profile directory')
const profile = resolve(process.argv[2]),
  directory = join(profile, 'node_modules/qualification-fixture'),
  path = join(profile, 'package.json'),
  metadata = JSON.parse(await readFile(path, 'utf8'))
if (!Array.isArray(metadata.dsh?.profile?.bundles))
  throw new Error('Pass an actual temporary DSH profile')
await mkdir(directory, { recursive: true })
await copyFile(new URL('./local-provider.mjs', import.meta.url), join(directory, 'index.js'))
await writeFile(
  join(directory, 'package.json'),
  JSON.stringify({
    name: 'qualification-fixture',
    version: '0.0.0',
    type: 'module',
    main: 'index.js',
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }),
)
await writeFile(
  join(directory, 'cordis.patch.yml'),
  '- insert:\n    - id: qualification-fixture\n      name: qualification-fixture\n',
)
if (!metadata.dsh.profile.bundles.includes('qualification-fixture'))
  metadata.dsh.profile.bundles.push('qualification-fixture')
await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`)
await writeFile(
  join(profile, '.dsh-browser-fixture.json'),
  JSON.stringify({ version: 1, profile }),
  { mode: 0o600 },
)
console.log('Prepared temporary local model fixture; no external model requests are made by it')
