# Maintainer tools

Run from the repository root with Node 24 and pnpm 11.9.0.

- Root scripts build packages and generate compiler configuration.
- `check/` validates packages, exports, declarations and installed artifacts.
- `release/` prepares tarballs, consumers and publication manifests.

Start with `pnpm verify`. Use `pnpm pack:release EMPTY_DIRECTORY` to pack without publishing.

See [development](../docs/development.md), [testing](../docs/testing.md) and [release preparation](../docs/release.md) for complete commands. Generated artifacts and private profiles stay ignored.
