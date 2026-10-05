# Testing

`pnpm test` runs the plugin/support unit tests and the live-budget unit test. It makes no paid provider calls. Installed-package checks live in `tools/check/`; `integration/presets.mjs` checks actual standard/PTC startup and restart without source aliases.

## Browser

Browser scripts require an isolated, marked fixture profile. They mutate configuration and create fixture chats. Never use the interactive profile.

```sh
node tests/browser/fixtures/prepare-profile.mjs ARTIFACT_DIRECTORY EMPTY_TEST_ROOT
# Install packages inside EMPTY_TEST_ROOT/dev/profiles/web.
npm install --prefix EMPTY_TEST_ROOT/dev/profiles/web --ignore-scripts --no-audit --no-fund
node tests/browser/fixtures/install.mjs EMPTY_TEST_ROOT/dev/profiles/web
```

Start the profile from its own directory with `DSH_HOME=EMPTY_TEST_ROOT/dev DSH_PROFILE=web node node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --host 127.0.0.1 --port 0`. Redirect startup output to a private log. Use absolute paths for these environment variables:

- `DSH_TEST_PROFILE`: the fixture profile directory.
- `DSH_QUALIFICATION_WEB_LOG`: its startup log inside the fixture home, containing the private connection URL.
- `PLAYWRIGHT_EXECUTABLE_PATH`: optional installed Chromium path. Otherwise install Chromium with `pnpm exec playwright install chromium`.

`pnpm qualify:browser` checks every plugin page in desktop/mobile light/dark layouts without signing in or entering credentials. Run individual behavior checks with `node tests/browser/builtin-controls.mjs`, `commands.mjs`, `editors.mjs`, `full-access.mjs`, `glob-context.mjs`, `globs.mjs`, `goal-edits.mjs`, `goal-policy.mjs` or `summaries.mjs`. The local model fixture refuses nonlocal inference. Scripts should use a fresh fixture for each run; results and screenshots are written under ignored `.qualification/`.

## Live providers

`live/accounts.mjs`, `live/media.mjs` and `live/video-3d.mjs` are manual, paid checks of installed packages. They are excluded from `pnpm test`. All runs require the same absolute `DSH_QUALIFICATION_BUDGET_DIR`; its durable ledger reserves before dispatch, enforces the aggregate $25 cap and retains unknown charges. Do not delete or reset that ledger to retry a failed request.

Supply credentials through the process environment, or explicitly load an ignored file with Node's `--env-file` option. Scripts never copy credentials from another profile or load `.env.local` automatically. Provider API keys stay out of chat and reports.

```sh
node tests/live/accounts.mjs INSTALLED_CONSUMER PRIVATE_DSH_HOME UNIQUE_RUN_ID
node tests/live/media.mjs INSTALLED_CONSUMER OUTPUT_DIRECTORY
node tests/live/video-3d.mjs INSTALLED_CONSUMER
```

Account checks require existing host credentials, explicit `DSH_CODEX_TEST_MODEL`/`DSH_ZAI_TEST_MODEL` selections and `DSH_CODEX_TEST_RESERVE_USD`/`DSH_ZAI_TEST_RESERVE_USD` worst-case quotes. Codex has no wire output cap, so a short prompt or deadline does not bound its bill. Media checks require `OPENROUTER_API_KEY` and, for fal operations, `FAL_KEY`. The 3D check takes an explicit test image through `DSH_FAL_3D_IMAGE`; it does not depend on a previous qualification job. Prefer free applicable models or inexpensive choices. `live/conversation-browser.mjs` additionally checks live routing metadata and attachment UI on a marked fixture; it requires explicitly configured provider keys and the same browser variables. It uses the local model fixture rather than paid inference.
