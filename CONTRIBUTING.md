# Contributing

Use Node 24 and pnpm 11.9.0. Follow the [development guide](docs/development.md) for the pinned DSH reference and Biome setup.

Run `pnpm check:fix`, then `pnpm verify`. Test behavior, disposal, cancellation and recovery when changing them. Keep upstream DSH unchanged, use public APIs and keep credentials on the host.

See [testing](docs/testing.md) and [release preparation](docs/release.md) for qualification. Publication requires a separate operator decision.
