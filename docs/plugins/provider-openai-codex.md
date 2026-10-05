# ChatGPT Codex reference

ChatGPT Codex subscription support in DSH, using the selected signed-in account: the standard `codex` chat route, the `codex-daybreak` cyber route, and subscription image generation. Named accounts use DSH authorization services.

## Routes and commands

- **`codex`**: Responses adapter with live model discovery: display names, per-model reasoning efforts (`minimal`…`max`), service tiers. `visibility: list` only; ordered by backend priority; 5-min TTL + ETag revalidation; only actual account-scoped catalogs retained on refresh failure.
- **`codex-daybreak`**: the Daybreak toggle: a second group in the model window listing only models advertising a Daybreak cyber access program. Every request carries `access_programs: { cyber }` (`daybreak_blue` default, `daybreak_red` via config). Verification is server-enforced; an unverified account fails at inference. The group lists nothing until the live catalog loads: cyber programs are per-account facts.

**Quota fallback**: a 429 whose body is quota exhaustion (`usage_limit_reached`, `usage_not_included`, `insufficient_quota`, `credit_balance_exhausted`, spend-limit codes: the official client's classification) switches to the next stored account and retries once. Generic 429s stay transient rate limits. Exclusions via `accountFallbackExclude`.

**Account commands** (always available): `/codex-accounts`, `/codex-use [NAME]`, `/codex-logout NAME`, `/codex-status`.

**Model commands** (mounted only while a Codex route is selected): `/codex-speed [standard|fast|ultrafast]` (service tiers), `/codex-image <prompt>`.

The `codex_image_generate` tool and runtime skill stay global: any model may spend the subscription.

Open **Plugins → ChatGPT Codex** to edit configuration and sign in with browser PKCE or a device code. Account grants remain on the host.

## Config

| Key | Default | Meaning |
|---|---|---|
| `endpoint` | ChatGPT backend | Responses endpoint override for chat |
| `speed` | `standard` | volatile: `standard`/`fast`/`ultrafast` service tier |
| `daybreakProgram` | `daybreak_blue` | `daybreak_blue` or `daybreak_red` |
| `accountFallback` | `true` | switch accounts on quota exhaustion |
| `accountFallbackExclude` | `""` | comma-separated account names never used |
| `imageModel` / `imageOutDir` | `gpt-image-2` / `codex-images` | image generation |

## Authentication lifecycle

Browser login uses cryptographic random PKCE material and SHA-256 encoded as base64url. Callback handling accepts only the authorization path, verifies state, respects cancellation, and expires after fifteen minutes. Device login requests a user code, polls the Codex device endpoint, and exchanges the issued authorization code using the server-provided verifier; it works without a localhost browser callback. See [official authentication guidance](https://learn.chatgpt.com/docs/auth).

Named accounts and their active selection live in one atomic `openai-codex/accounts` credential grant. Login commits that grant through the authorization service; cancellation before commit leaves existing accounts unchanged. Logout removes the account and clears its active selection in the same update. Refresh rotation checks the prior access-token version, so late responses cannot overwrite a new login or restore a removed account. No marker or pointer records are used.

Catalog caches and ETag revalidation are scoped to the account name, backend account ID and access-token generation. Switching accounts, replacing a token or logging out cannot reuse another account's cached capabilities; late responses from an old account do not replace the active cache. Service-tier eligibility uses the same credential snapshot as its inference attempt. Model discovery and quota-fallback refreshes preserve request cancellation. Cancellation before switching leaves the active account unchanged; cancellation after an already committed switch stops refresh and inference rather than reverting that selection.

Automatic quota fallback uses an atomic compare-and-switch against a persisted selection identifier. Any manual selection, including switching away and back, invalidates the pending automatic switch. Pool deletion and recreation get a fresh identifier. Refresh retries stay bound to the account rejected by the backend, and a second 401 emits one terminal authentication failure. The pool format is `codex-accounts-v2`; unsupported experimental pool grants must be cleared before authorizing again. There is no migration path.

Signed-out accounts advertise no invented model catalog. Chat requests have configurable deadlines and abort when their capability generation is disposed.

## Model catalog and wire protocol

The catalog protocol version is qualified against Codex 0.160.0 and is independent of this package’s 0.1.0 release version. The backend returns an empty catalog for an obsolete protocol version. Subscription-only models are retained; unknown context windows stay unknown, and default capacity uses context_window rather than an experimental maximum. An initial catalog failure is reported; only previously observed data for the same credential generation can survive a refresh failure.

The pinned reference is Codex CLI commit `604061ce51d194a3aa6aad3b3170240d096e1725`. Chat requests set `store:false`; catalog protocol version remains the qualified `0.160.0`. Refresh sends JSON and rotates inside the native credential transaction. Native subscription Responses does not expose an output-token cap; an explicit `maxTokens` request fails before dispatch rather than silently dropping the limit. Request timeouts remain available.

## Image generation

Images use the current standalone `images/generations` protocol and `data[].b64_json`, with one image per call. Configuration exposes the dedicated image endpoint, model, quality, size, background, deadline, response/file byte limit, output directory and independent tool, command and skill controls. Output suffixes follow the actual image bytes. Unsupported old Responses image result shapes and invented output-format controls are removed.

## Local usage observations

Usage observations belong to this provider. Configure tracking and recorded failure codes in ChatGPT Codex. `/codex-usage status` lists observed Codex and Daybreak rate-limit facts. `/codex-usage reset confirm` clears those local facts. It does not reset account quotas on the server.

Subscription Web Search uses this provider's active account and refresh service. Configure search in Web Search; change the account here.

## Subscription quota and resets

Each signed-in account has its own subscription/quota card, including inactive accounts. Status comes from the official WHAM usage and reset-credit endpoints; reading it never changes the active account. Only available, unexpired reset credits produce a reset button. Confirmation consumes that entitlement using an idempotent redemption ID. `/codex-usage reset confirm` clears local observations only.
