/** Verify shipped exports and execute browser factories through DSH's documented module-loader handoff. */

import assert from 'node:assert/strict'
import { access, readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
let count = 0
for (const group of ['support', 'plugins'])
  for (const entry of await readdir(join(root, group))) {
    const dir = join(root, group, entry)
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    for (const value of Object.values(manifest.exports)) {
      const targets = typeof value === 'string' ? [value] : Object.values(value)
      for (const target of targets) if (!target.includes('*')) await access(join(dir, target))
    }
    const english = JSON.parse(await readFile(join(dir, 'locale/en.json'), 'utf8'))
    assert(
      english.meta.title && english.meta.title !== manifest.name,
      `${manifest.name}: human display title required`,
    )
    if (manifest.dsh?.client) {
      let captured
      vm.runInNewContext(
        await readFile(join(dir, 'lib/client.js'), 'utf8'),
        {
          window: {
            __ModuleLoader__: {
              load: (registration) => {
                captured = registration
              },
            },
          },
        },
        { timeout: 1000, filename: `${manifest.name}/client.js` },
      )
      assert.equal(captured.id, manifest.name)
      const exported = captured.factory((id) =>
        id === '@deepseek-ai/dsh-client-ui-primitives' ? { Button() {}, Input() {} } : require(id),
      )
      assert.equal(typeof exported.apply, 'function')
      assert(exported.inject.includes('configForms'))
    }
    count++
  }
const wire = await import(pathToFileURL(join(root, 'support/openai-wire/lib/index.js')).href)
const decoder = new wire.SseDecoder()
assert.deepEqual(decoder.push(new TextEncoder().encode('data: İstanbul 🌍\n\n')), ['İstanbul 🌍'])
console.log(`Built export and browser factory checks passed (${count} packages)`)
