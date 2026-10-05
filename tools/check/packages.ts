/**
 * Package invariants gate: every @loncothad/dsh-* package must satisfy the
 * workspace's publishing contract before a release. Exits nonzero naming
 * each violation — the same role upstream's verify-package-invariants
 * plays.
 *
 * Checked invariants:
 *   1. manifest completeness (name/version/description/license/files/
 *      publishConfig/repository/keywords/engines/scripts/devDependencies)
 *   2. name <-> directory match; coordinated first release version
 *   3. files list ships compiled modules and the bundle manifest
 *   4. every runtime import of an owned package appears in
 *      dependencies or peerDependencies
 *   5. workspace:* cross-dependencies resolve to workspace packages
 *   6. per-package vitest.config.ts, tests/, LICENSE, README.md exist
 *
 * Run from anywhere:  pnpm verify's first stage
 * (tsx tools/check/packages.ts)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Manifest = Record<string, unknown> & {
  name?: string
  scripts?: Record<string, unknown>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  files?: string[]
  license?: string
  publishConfig?: unknown
  engines?: unknown
}

function findRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../..')
}

/** Collect every file (relative path) under dir, recursively. */
function walkFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walkFiles(full))
    } else {
      out.push(full)
    }
  }
  return out
}

const ROOT = findRoot()
const LICENSE_LINE = 'Copyright (c) 2026, dsh plugin contributors'

const REQUIRED_KEYS = [
  'name',
  'version',
  'description',
  'license',
  'files',
  'publishConfig',
  'repository',
  'keywords',
  'engines',
  'scripts',
  'devDependencies',
]
const REQUIRED_SCRIPTS = ['test', 'typecheck']

// Pass 1: collect every package and its manifest.
const packages = new Map<string, Manifest>()
for (const group of ['plugins', 'support']) {
  const groupDir = join(ROOT, group)
  if (!existsSync(groupDir)) continue
  for (const entry of readdirSync(groupDir).sort()) {
    const manifestPath = join(groupDir, entry, 'package.json')
    if (!existsSync(manifestPath)) continue
    const m: Manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    packages.set(`${group}/${entry}`, m)
  }
}

const allNames = new Set([...packages.values()].map((m) => m.name!))
const violations: string[] = []

// Pass 2: check each package against the contract.
for (const [rel, m] of packages) {
  const [group, entry] = rel.split('/') as [string, string]
  const pkgDir = join(ROOT, group, entry)

  const fail = (problem: string) => {
    violations.push(`${rel}: ${problem}`)
  }

  for (const key of REQUIRED_KEYS) {
    if (!(key in m)) fail(`missing ${key}`)
  }
  for (const script of REQUIRED_SCRIPTS) {
    if (!(script in (m.scripts ?? {}))) fail(`missing scripts.${script}`)
  }
  if (m.license !== 'MIT') fail(`license is ${JSON.stringify(m.license)}, expected MIT`)
  if (m.version !== '0.1.0') fail('first release candidate version must be 0.1.0')
  if (JSON.stringify(m.publishConfig) !== JSON.stringify({ access: 'public' })) {
    fail('publishConfig must be {"access": "public"}')
  }
  if (m.name !== `@loncothad/dsh-${entry}`) {
    fail(`name ${JSON.stringify(m.name)} does not match directory ${JSON.stringify(entry)}`)
  }
  const files = m.files ?? []
  if (!files.includes('lib')) fail('files must ship compiled JavaScript in lib')
  if (m.main !== 'lib/index.js') fail('main must load compiled JavaScript')
  if ((m.exports as Record<string, unknown>)?.['./locale/*.json'] !== './locale/*.json')
    fail('locale resources must be exported')
  if (existsSync(join(pkgDir, 'cordis.patch.yml')) && !files.includes('cordis.patch.yml')) {
    fail('bundle manifest exists but is not in files')
  }
  if (JSON.stringify(m.engines) !== JSON.stringify({ node: '>=24' })) {
    fail('engines must be {"node": ">=24"}')
  }
  for (const [dep, spec] of Object.entries(m.dependencies ?? {})) {
    if (spec === 'workspace:*' && !allNames.has(dep)) {
      fail(`workspace:* dep ${dep} is not a workspace package`)
    }
  }

  for (const required of ['vitest.config.ts', 'LICENSE', 'README.md']) {
    if (!existsSync(join(pkgDir, required))) fail(`missing ${required}`)
  }
  if (!existsSync(join(pkgDir, 'tests'))) fail('missing tests/')
  if (!readFileSync(join(pkgDir, 'LICENSE'), 'utf8').includes(LICENSE_LINE)) {
    fail('LICENSE copyright line differs from the shared one')
  }

  // Runtime cross-package imports must be declared and resolvable.
  const declared = new Set([
    ...Object.keys(m.dependencies ?? {}),
    ...Object.keys(m.peerDependencies ?? {}),
  ])
  const srcDir = join(pkgDir, 'src')
  if (existsSync(srcDir)) {
    for (const file of walkFiles(srcDir)) {
      if (!file.endsWith('.ts')) continue
      const text = readFileSync(file, 'utf8')
      const imported = new Set(
        [...text.matchAll(/from '(@loncothad\/dsh-[a-z0-9-]+)(?:\/[^']*)?'/g)].map(
          (match) => match[1]!,
        ),
      )
      for (const name of imported) {
        if (name === m.name) continue
        if (!declared.has(name)) fail(`imports ${name} but does not declare it`)
        if (!allNames.has(name)) fail(`imports ${name} which is not a workspace package`)
      }
    }
  }
}

if (violations.length > 0) {
  console.log(`PACKAGE INVARIANT FAILURES (${violations.length}):`)
  for (const violation of violations) console.log('  -', violation)
  process.exit(1)
}
console.log(`package invariants ok (${packages.size} packages)`)
