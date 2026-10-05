# Release preparation

Prepare coordinated `0.1.0` packages for `loncothad/dsh-plugins` and the `@loncothad` npm scope. Do not publish, push or create a release as part of verification.

## Build and pack

```sh
pnpm verify
pnpm verify:registry
pnpm pack:release /absolute/path/to/empty-artifacts
node tools/check/tarballs.mjs /absolute/path/to/empty-artifacts
node tools/release/manifest.mjs /absolute/path/to/empty-artifacts /absolute/path/to/release-manifest.json
```

Packing with pnpm converts `workspace:*` dependencies to published version ranges. Tarball checks inspect exports, dependencies, licenses and excluded development/secret files. Packages ship compiled ESM, declarations, browser factories, worker bundles, locale resources and debugging sources. Browser bundles include third-party notices.

Keep the manifest with the candidate: it records package hashes and dependency-ordered publication. Publish support dependencies before dependent plugins when publication is separately authorized.

## Independent consumer

```sh
node tools/release/prepare-consumer.mjs ARTIFACT_DIRECTORY EMPTY_CONSUMER_DIRECTORY
cd EMPTY_CONSUMER_DIRECTORY
npm install --ignore-scripts --no-audit --no-fund
```

Return to this repository and run:

```sh
node tools/check/installed.mjs CONSUMER_DIRECTORY
node tools/check/declarations.mjs CONSUMER_DIRECTORY
node tests/integration/presets.mjs CONSUMER_DIRECTORY
```

These checks import registry-installed SDK peers without source aliases, initialize the installed SQLite worker, check NodeNext declarations and exercise standard/PTC startup and restart. A full DSH web profile may need its own native dependency setup.

## Qualification

Use a clean, unchanged DSH reference at the pinned revision in [development](development.md). Qualify packed artifacts, not development aliases. Test Node 24 on supported operating systems, native worker startup, configuration reload/disposal, authentication cancellation, routing/privacy, media protocols and compactor recovery.

Use the [isolated browser fixtures](testing.md#browser) for desktop/mobile, theme, keyboard, settings, selector and attachment checks. Optional live provider checks use operator-configured credentials, prefer free or inexpensive models and share one durable $25 reservation ledger. Unknown charges remain reserved.

Record exact commands, candidate hashes, platform results and unresolved gates with the artifacts. Do not place private logs or credentials in the repository or tarballs. No CI workflow is currently checked in; cross-platform qualification needs an operator-managed runner. Report readiness only after required gates pass.
