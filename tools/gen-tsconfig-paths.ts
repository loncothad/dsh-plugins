/** Generate local source resolution and separate Host/Client compiler faces without modifying DSH. */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = resolve(
  process.env.DSH_SOURCE_DIR ?? join(root, '..', 'external', 'deepseek-harness-release'),
)
if (!existsSync(join(harness, 'tsconfig.base.json')))
  throw new Error('Set DSH_SOURCE_DIR to an installed DSH source checkout')
const base = JSON.parse(
  readFileSync(join(harness, 'tsconfig.base.json'), 'utf8').replace(/^[ \t]*\/\/.*$/gm, ''),
) as { compilerOptions: { paths: Record<string, string[]> } }
const sourcePaths: Record<string, string[]> = {}
const rel = (path: string) => `./${relative(root, path).replaceAll('\\', '/')}`
for (const [name, targets] of Object.entries(base.compilerOptions.paths)) {
  sourcePaths[name] = targets.map((target) => rel(resolve(harness, target)))
}
sourcePaths['@deepseek-ai/dsh-client-ui-chat/src/*'] = [
  rel(join(harness, 'packages/client/ui-chat/src/*')),
]
const packages: string[] = []
for (const group of ['plugins', 'support'])
  for (const entry of readdirSync(join(root, group)).sort()) {
    const dir = join(root, group, entry)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name: string
      exports?: Record<string, string | { default?: string }>
    }
    const local = rel(join(dir, 'src/index.ts'))
    sourcePaths[m.name] = [local]
    if (existsSync(join(dir, 'src/client.ts')))
      sourcePaths[`${m.name}/client`] = [rel(join(dir, 'src/client.ts'))]
    if (existsSync(join(dir, 'src/client/index.ts')))
      sourcePaths[`${m.name}/client`] = [rel(join(dir, 'src/client/index.ts'))]
    for (const [subpath, exported] of Object.entries(m.exports ?? {})) {
      const target = typeof exported === 'string' ? exported : exported.default
      if (!subpath.startsWith('./') || subpath.includes('*') || !target) continue
      const match = /^\.\/lib\/(.+)\.js$/.exec(target)
      const source = match ? join(dir, 'src', `${match[1]}.ts`) : undefined
      if (source && existsSync(source)) sourcePaths[m.name + subpath.slice(1)] = [rel(source)]
    }
    packages.push(`${group}/${entry}`)
  }
const options = {
  target: 'ES2024',
  module: 'ESNext',
  moduleResolution: 'Bundler',
  strict: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  types: ['node'],
  paths: sourcePaths,
}
const write = (name: string, data: unknown) =>
  writeFileSync(join(root, name), `${JSON.stringify(data, null, 2)}\n`)
write('tsconfig.paths.json', { compilerOptions: { paths: sourcePaths } })
write('tsconfig.json', {
  compilerOptions: options,
  include: [
    'plugins/*/src/**/*.ts',
    'plugins/*/tests/**/*.ts',
    'support/*/src/**/*.ts',
    'support/*/tests/**/*.ts',
    'tools/**/*.ts',
    'tests/**/*.spec.ts',
    'vitest*.ts',
  ],
  exclude: [
    'plugins/*/tests/client/**',
    'support/*/tests/client/**',
    'plugins/*/src/client/**',
    'support/*/src/client.ts',
    'support/*/src/*-client.ts',
  ],
})
write('tsconfig.client.json', {
  compilerOptions: {
    ...options,
    jsx: 'react-jsx',
    lib: ['ES2024', 'DOM', 'DOM.Iterable', 'ESNext.Disposable'],
    types: ['react', 'node'],
  },
  include: [
    'plugins/*/tests/client/**/*.ts',
    'support/*/tests/client/**/*.ts',
    'plugins/*/src/client/**/*.ts',
    'support/*/src/client.ts',
    'support/*/src/*-client.ts',
  ],
})
for (const pkg of packages)
  write(`${pkg}/tsconfig.json`, {
    extends: '../../tsconfig.json',
    include: ['src/**/*.ts', 'tests/**/*.ts', 'vitest.config.ts'],
    exclude: ['tests/client/**', 'src/client/**', 'src/client.ts'],
  })
console.log(`Generated source resolution and compiler faces for ${packages.length} packages`)
