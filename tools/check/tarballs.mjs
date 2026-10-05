/** Inspect the packed artifact, including pnpm's workspace dependency rewrite. No registry writes. */

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const artifacts = resolve(process.argv[2] ?? resolve(root, 'artifacts'))
const expected = new Map()
for (const group of ['plugins', 'support'])
  for (const entry of await readdir(resolve(root, group))) {
    const manifest = JSON.parse(await readFile(resolve(root, group, entry, 'package.json'), 'utf8'))
    expected.set(manifest.name, manifest)
  }
const observed = new Set()
for (const file of await readdir(artifacts)) {
  if (!file.endsWith('.tgz')) continue
  const tar = gunzipSync(await readFile(resolve(artifacts, file)), {
    maxOutputLength: 32 * 1024 * 1024,
  })
  const contents = new Map()
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start, end) =>
      header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '').trim()
    const size = Number.parseInt(field(124, 136), 8)
    assert(
      Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length,
      `${file}: malformed tar size`,
    )
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join('/')
    assert(!name.startsWith('/') && !name.split('/').includes('..'), `${file}: unsafe tar path`)
    if (header[156] === 48 || header[156] === 0)
      contents.set(name, tar.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  const manifest = JSON.parse(contents.get('package/package.json')?.toString('utf8') ?? 'null')
  assert(manifest && expected.has(manifest.name), `${file}: unexpected package`)
  assert(!observed.has(manifest.name), `${file}: duplicate package artifact`)
  observed.add(manifest.name)
  assert.equal(manifest.version, expected.get(manifest.name).version)
  assert(contents.has('package/LICENSE'), `${file}: missing license`)
  assert(contents.has('package/README.md'), `${file}: missing instructions`)
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    assert(!/^(workspace|link|file):/.test(version), `${file}: unpublished dependency ${name}`)
    if (expected.has(name)) assert.equal(version, expected.get(name).version)
  }
  for (const value of Object.values(manifest.exports)) {
    for (const target of typeof value === 'string' ? [value] : Object.values(value)) {
      if (!target.includes('*'))
        assert(
          contents.has(`package/${target.replace(/^\.\//, '')}`),
          `${file}: missing export ${target}`,
        )
    }
  }
  for (const name of contents.keys())
    assert(
      !/(^|\/)(node_modules|\.env(?:\.|$)|\.npmrc|artifacts|tests)(\/|$)/.test(name),
      `${file}: development or secret material included`,
    )
}
assert.equal(observed.size, expected.size, 'Pack every package before verifying tarballs')
console.log(`Tarball export, dependency, and contents checks passed (${observed.size} packages)`)
