/** Describe exact local tarballs and dependency order. This never publishes or contacts a registry. */
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  directory = resolve(process.argv[2] ?? ''),
  output = process.argv[3]
if (!process.argv[2] || !output)
  throw Error('Usage: node tools/release/manifest.mjs ARTIFACT_DIRECTORY OUTPUT_JSON')
const packages = new Map()
for (const group of ['support', 'plugins'])
  for (const name of (await readdir(join(root, group))).sort()) {
    const manifest = JSON.parse(await readFile(join(root, group, name, 'package.json'), 'utf8'))
    packages.set(manifest.name, manifest)
  }
const ordered = [],
  visiting = new Set(),
  visited = new Set()
function visit(name) {
  if (visited.has(name)) return
  if (visiting.has(name)) throw Error(`Owned dependency cycle at ${name}`)
  visiting.add(name)
  const p = packages.get(name)
  for (const dep of Object.keys({ ...p.dependencies, ...p.peerDependencies }).sort())
    if (packages.has(dep)) visit(dep)
  visiting.delete(name)
  visited.add(name)
  ordered.push(name)
}
for (const name of [...packages.keys()].sort()) visit(name)
const entries = []
for (const name of ordered) {
  const p = packages.get(name),
    tarball = `${name.replace('@', '').replace('/', '-')}-${p.version}.tgz`,
    data = await readFile(join(directory, tarball))
  entries.push({
    name,
    version: p.version,
    tarball,
    sha256: createHash('sha256').update(data).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(data).digest('base64')}`,
    dependencies: Object.keys({ ...p.dependencies, ...p.peerDependencies })
      .filter((d) => packages.has(d))
      .sort(),
    license: p.license,
    repository: p.repository,
  })
}
await writeFile(
  resolve(output),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), repository: 'loncothad/dsh-plugins', owner: 'loncothad', node: '24.21.0', pnpm: '11.9.0', dsh: { tag: 'dsh-v0.2.0-rc.2', commit: '639ed015397290b3745d163aafe02ffee4aa3f84' }, publicationStatus: 'prepared_only', qualificationReport: 'qualification-report.md', publicationOrder: entries }, null, 2)}\n`,
)
console.log(`Prepared exact release manifest for ${entries.length} packages; no registry writes`)
