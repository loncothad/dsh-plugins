/** Prepare an empty consumer directory from verified tarballs; never installs or executes packages. */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
if (process.argv.length !== 4)
  throw new Error(
    'Usage: node tools/release/prepare-consumer.mjs ARTIFACT_DIRECTORY EMPTY_CONSUMER_DIRECTORY',
  )
const artifacts = resolve(process.argv[2]),
  consumer = resolve(process.argv[3])
await mkdir(consumer, { recursive: true })
if ((await readdir(consumer)).length) throw new Error('Consumer directory must be empty')
const dependencies = {}
const owned = []
for (const group of ['plugins', 'support'])
  for (const entry of await readdir(resolve(root, group)))
    owned.push(JSON.parse(await readFile(resolve(root, group, entry, 'package.json'), 'utf8')))
const names = new Set(owned.map((manifest) => manifest.name))
for (const manifest of owned) {
  const tarball = resolve(
    artifacts,
    `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`,
  )
  if (!(await stat(tarball)).isFile()) throw new Error(`Missing tarball for ${manifest.name}`)
  dependencies[manifest.name] = pathToFileURL(tarball).href
  for (const [name, version] of Object.entries(manifest.peerDependencies ?? {}))
    if (!names.has(name)) {
      if (dependencies[name] && dependencies[name] !== version)
        throw new Error(`Conflicting peer versions for ${name}`)
      dependencies[name] = version
    }
}
await writeFile(
  resolve(consumer, 'package.json'),
  `${JSON.stringify(
    {
      private: true,
      type: 'module',
      dependencies,
      allowScripts: { 'better-sqlite3@13.0.3': true },
    },
    null,
    2,
  )}\n`,
)
console.log(`Prepared ${owned.length} packed packages and their exact peers in ${consumer}`)
