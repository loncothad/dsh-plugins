# DSH plugins

This is the owned source for `loncothad/dsh-plugins`. Preserve existing uncommitted work. Do not publish, push, or create a release without an explicit user request.

- `plugins/`: installable capability bundles. `support/`: shared libraries with demonstrated consumers. Package names are `@loncothad/dsh-<directory>`, version `0.1.0`, MIT.
- DSH target: `dsh-v0.2.0-rc.2`, commit `639ed015397290b3745d163aafe02ffee4aa3f84`.
- Use public DSH configuration, authorization, model, tool, session, workspace and UI APIs. Keep the native event vocabulary. Plugin state belongs in scoped private SQLite journals, with revision fences and explicit dependencies.
- Own cancellation, timers, workers and registrations. Dispose before replacing capabilities. Bound inputs, responses, concurrency, storage and retries. Reject stale publication and explain failures.
- Credentials stay on the host. Resolve them through the selected provider or Secrets Broker. Never expose keys, grants, authorization URLs or private logs in browser payloads, prompts, screenshots or delivery archives. `.env.local` and `.qualification/` are private.
- A model answer is an attestation, not permission or proof. Policy controls dispatch; evidence and independent review control completion. Preserve user constraints and corrections. Never relax privacy, permission or completion rules automatically.
- UI uses native DSH primitives and theme tokens, concise labels, keyboard access and responsive layouts. Avoid duplicated forms, raw JSON for routine controls and extra composer buttons. Keep original human messages and attachments unchanged.
- External summary text is presentation-only and absent from main-model context and compaction. Heads Up notices have the same boundary until explicit human discussion. Goal reports and audit feedback are explicitly model-visible. Glob snapshots are bounded file-name data, never instructions or file contents.
- Goal tweaks keep identity, accepted evidence and spent native rounds. Replacements start fresh and archive the source only after confirmation. Model proposals never authorize either change.
- No legacy aliases or speculative adapters. Remove dead paths. Do not invent unavailable metrics, model capabilities or confidence scores. Explain host limits without patching registries or hiding native DOM.

Use Node 24 and pnpm 11.9.0. `pnpm check:fix` applies Biome formatting and reviewed safe fixes. `pnpm verify` checks style, package invariants, both compiler faces, compiled exports and tests. It reports upstream diagnostics separately; owned diagnostics must be zero. Add meaningful tests for behavior, cancellation, persistence or contract changes.

Build before packing. `pnpm pack:release EMPTY_DIRECTORY` packs coordinated packages on Linux and Windows; `node tools/check/tarballs.mjs DIRECTORY` verifies their contents and dependency ranges. Qualify installed tarballs without source aliases. Browser fixtures stay in temporary profiles, never the interactive profile. The user authorized Playwright when the in-app browser is unavailable.

Live qualification prefers free or inexpensive models. Use the shared reservation ledger and its $25 aggregate cap; reserve before dispatch and retain unknown charges. Never spend reset entitlements merely to test a button.

Read package READMEs for behavior, `docs/architecture.md` for boundaries, and `docs/development.md`, `docs/testing.md` and `docs/release.md` for maintainer checks. Keep private qualification reports under `.qualification/` and update measured results when scope changes. Report actual checks and remaining limits; do not claim production readiness while required gates remain open.
