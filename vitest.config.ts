import { defineConfig } from 'vitest/config'
import { harnessAliases } from './vitest.shared.ts'

// Workspace-wide aggregate: every plugin package's tests in one run.
// Each package also carries its own vitest.config.ts for standalone runs.
export default defineConfig({
  resolve: { alias: harnessAliases(), dedupe: ['react', 'react-dom'] },
  test: {
    include: ['plugins/*/tests/**/*.spec.ts', 'support/*/tests/**/*.spec.ts', 'tests/**/*.spec.ts'],
    environment: 'node',
  },
})
