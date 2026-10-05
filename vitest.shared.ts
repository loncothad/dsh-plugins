/**
 * Shared vitest configuration for the dsh-plugins workspace.
 *
 * `harnessAliases()` builds vite `resolve.alias` entries from the
 * generated source-resolution map (tsconfig.paths.json, from
 * tools/gen-tsconfig-paths.ts): every harness package and every local
 * plugin package resolves to its unbuilt TypeScript source. Source-mode
 * resolution must win over package exports so built lib/ never loads and
 * no second module-singleton copy can appear.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const sharedDir = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = sharedDir

/** Absolute-path alias map for the vendored harness and local plugins. */
export function harnessAliases(): Record<string, string> {
  const facade = JSON.parse(
    readFileSync(resolve(workspaceRoot, 'tsconfig.paths.json'), 'utf8'),
  ) as { compilerOptions?: { paths?: Record<string, string[]> } }
  const paths = facade.compilerOptions?.paths ?? {}
  const aliases: Record<string, string> = {}
  for (const [name, targets] of Object.entries(paths)) {
    const target = targets[0]
    if (target === undefined) continue
    // Facade targets are workspace-root-relative (baseUrl '.').
    const absolute = resolve(workspaceRoot, target)
    if (absolute.endsWith('.ts')) {
      aliases[name] = absolute
    } else if (existsSync(resolve(absolute, 'index.ts'))) {
      aliases[name] = resolve(absolute, 'index.ts')
    } else {
      aliases[name] = absolute
    }
  }
  // Subpath aliases must beat their root.
  return Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => b.length - a.length))
}

/** Vitest config for one plugin package: its own tests, shared aliases. */
export function definePackageConfig(_packageDirUrl: string) {
  return defineConfig({
    resolve: { alias: harnessAliases(), dedupe: ['react', 'react-dom'] },
    test: {
      include: ['tests/**/*.spec.ts'],
      environment: 'node',
    },
  })
}
