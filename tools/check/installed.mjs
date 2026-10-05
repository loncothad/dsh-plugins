/** Smoke-test packed host entry points against an independent consumer installation. No plugin activation. */

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
if (!process.argv[2]) throw new Error('Pass the directory of a clean consumer installation')
const consumer = resolve(process.argv[2]),
  failures = []
let count = 0
for (const group of ['support', 'plugins'])
  for (const entry of await readdir(resolve(root, group))) {
    const expected = JSON.parse(await readFile(resolve(root, group, entry, 'package.json'), 'utf8'))
    try {
      const dir = resolve(consumer, 'node_modules', expected.name)
      const actual = JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8'))
      if (actual.version !== expected.version) throw new Error('Installed package version differs')
      const target = actual.exports['.'].default
      const module = await import(pathToFileURL(resolve(dir, target)).href)
      if (!Object.keys(module).length) throw new Error('Host entry point exports nothing')
      count++
    } catch (error) {
      failures.push(`${expected.name}: ${error instanceof Error ? error.message : 'Import failed'}`)
    }
  }
for (const failure of failures) console.error(failure)
console.log(`Installed host modules: ${count} imported, ${failures.length} failed`)
if (!failures.length) {
  const evidence = await import(
    pathToFileURL(resolve(consumer, 'node_modules/@loncothad/dsh-evidence-store/lib/index.js')).href
  )
  const store = new evidence.EvidenceStore(':memory:', 'consumer')
  try {
    const scope = { workspaceId: 'consumer', sessionId: 'installation' }
    const original = 'Original installed evidence: İstanbul 🌍. No publication approval.'
    const captured = await store.capture(scope, {
      id: 'installed',
      role: 'user',
      group: 'closed',
      closed: true,
      text: original,
    })
    assert.equal((await store.read(scope, captured.evidenceIds))[0].quote, original)
    assert.equal((await store.status()).sqliteVersion, '3.53.4')
    console.log('Installed native SQLite worker capture/read passed')
  } finally {
    await store.close()
  }
}
if (failures.length) process.exitCode = 1
