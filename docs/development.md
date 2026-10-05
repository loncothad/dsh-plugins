# Development

Use Node 24.21.0 and pnpm 11.9.0. `plugins/` contains capability bundles; `support/` contains shared libraries. Packages use `@loncothad/dsh-<directory>`, version `0.1.0` and MIT licensing.

## Reference setup

Keep upstream DSH in a separate, unchanged checkout at `dsh-v0.2.0-rc.2`, commit `639ed015397290b3745d163aafe02ffee4aa3f84`. Install its dependencies with its frozen lockfile.

```sh
pnpm install --frozen-lockfile
DSH_SOURCE_DIR=/absolute/path/to/deepseek-harness pnpm regen:paths
pnpm verify
```

In PowerShell set `$env:DSH_SOURCE_DIR='C:\absolute\path'` before running `pnpm regen:paths`. Without this variable, the generator looks for `../external/deepseek-harness-release`. Generated compiler files are ignored by Git.

Host and Client have separate strict compiler programs. Owned diagnostics must be zero; upstream diagnostics are reported separately. These checks do not replace upstream's own build or typecheck.

## Format and lint

Biome 2.5.15 handles formatting, recommended lint rules and import organization. Warnings fail checks.

| Command | Purpose |
| --- | --- |
| `pnpm check` | Check format, lint and imports |
| `pnpm check:fix` | Apply formatting and reviewed safe fixes |
| `pnpm format` | Format only |
| `pnpm lint` | Lint only |
| `pnpm verify` | Style, package invariants, typecheck, build, exports and tests |

Formatting uses two spaces, LF, single JavaScript quotes and semicolons only where needed. `.editorconfig` aligns other editors. Ignored files, generated artifacts and dependencies are excluded. Narrow inline exceptions explain deliberate control-character filters or invariant checks.

## Maintainer tools

| Task | Entry point |
| --- | --- |
| Synchronize package metadata | `pnpm sync:manifests` |
| Build the SQLite test worker | `node tools/build-worker.mjs`, also called by `pnpm test` |
| Inspect compiled exports and browser factories | `node tools/check/build.mjs` |
| Check external peer versions on npm | `pnpm verify:registry` |
| Pack without publishing | `pnpm pack:release EMPTY_DIRECTORY` |
| Verify tarballs | `node tools/check/tarballs.mjs ARTIFACT_DIRECTORY` |
| Record hashes and publication order | `node tools/release/manifest.mjs ARTIFACT_DIRECTORY OUTPUT_JSON` |

Use public DSH APIs, native controls and theme tokens. Own disposal, cancellation, revision fencing and bounded resources. Models cannot grant permission, change human completion policy or manufacture evidence. Credentials belong to the selected provider and stay on the host.

Read [architecture](architecture.md), [testing](testing.md) and [release preparation](release.md) for the relevant contracts. Keep private logs, profiles, keys and qualification reports out of source and release archives.
