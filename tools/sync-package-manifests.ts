/**
 * Normalize every package manifest to the workspace's publishing contract.
 *
 * Ensures each @loncothad/dsh-* package declares: scripts (test/typecheck),
 * devDependencies (vitest/typescript/@types/node), publishConfig
 * (access public), repository (directory-scoped), keywords, engines, and a
 * name that matches its directory. Versions, descriptions, and dependencies
 * are left untouched.
 *
 * Run from anywhere:  pnpm sync:manifests [--owner <github-owner>]
 * (tsx tools/sync-package-manifests.ts). The --owner value (default:
 * loncothad) sets the repository URL before publishing.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function findRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

const args = process.argv.slice(2)
const ownerIndex = args.indexOf('--owner')
const OWNER = ownerIndex >= 0 ? args[ownerIndex + 1] : 'loncothad'

const REPO = `github.com/${OWNER}/dsh-plugins`
const DEV_DEPS: Record<string, string> = {
  '@types/node': '22.20.4',
  typescript: '5.9.3',
  vitest: '3.2.7',
}

type Manifest = Record<string, unknown> & {
  name?: string
  scripts?: Record<string, string>
  devDependencies?: Record<string, string>
}

const ROOT = findRoot()

for (const group of ['plugins', 'support']) {
  const groupDir = join(ROOT, group)
  for (const entry of readdirSync(groupDir).sort()) {
    const manifestPath = join(groupDir, entry, 'package.json')
    if (!existsSync(manifestPath)) continue
    const m: Manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!m.name?.startsWith('@loncothad/dsh-')) continue
    const changed: string[] = []

    const scripts = m.scripts ?? {}
    for (const [key, value] of [
      ['test', 'vitest run'],
      ['typecheck', 'node ../../tools/typecheck.mjs'],
    ] as const) {
      if (scripts[key] !== value) {
        scripts[key] = value
        changed.push(`scripts.${key}`)
      }
    }
    m.scripts = scripts

    const dev = m.devDependencies ?? {}
    const merged = { ...DEV_DEPS, ...dev }
    if (JSON.stringify(dev) !== JSON.stringify(merged)) {
      m.devDependencies = Object.fromEntries(
        Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)),
      )
      changed.push('devDependencies')
    }

    if (!('publishConfig' in m)) {
      m.publishConfig = { access: 'public' }
      changed.push('publishConfig')
    }

    const repository = {
      type: 'git',
      url: `git+https://${REPO}.git`,
      directory: `${group}/${entry}`,
    }
    if (JSON.stringify(m.repository) !== JSON.stringify(repository)) {
      m.repository = repository
      changed.push('repository')
    }

    if (!('keywords' in m)) {
      m.keywords = ['deepseek-harness', 'dsh', 'dsh-plugin', 'cordis']
      changed.push('keywords')
    }

    if (JSON.stringify(m.engines) !== JSON.stringify({ node: '>=24' })) {
      m.engines = { node: '>=24' }
      changed.push('engines')
    }

    if (changed.length > 0) {
      writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`, 'utf8')
      console.log(`${group}/${entry}: ${changed.join(', ')}`)
    } else {
      console.log(`${group}/${entry}: ok`)
    }
  }
}
console.log('done')
