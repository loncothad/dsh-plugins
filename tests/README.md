# Tests

`pnpm test` runs unit and contract tests without paid provider calls.

- `browser/`: UI and interaction checks in isolated fixture profiles.
- `integration/`: installed standard/PTC startup and restart checks.
- `live/`: optional provider checks with an explicit shared spending ledger.

Never run browser mutations against the interactive profile. Live checks reserve spending before dispatch and share a $25 cap.

See the [testing guide](../docs/testing.md) for setup and commands, and [release preparation](../docs/release.md) for installed-package checks.
