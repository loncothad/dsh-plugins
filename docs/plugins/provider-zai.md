# Z.AI GLM reference

Sign in through ZCode or add a coding-plan API key in Plugins. Name each account; use or remove it from the account list. The active account supplies the `zai` model route. The separate `zai-coding-cn` route uses its own configured key.

Every saved account has a subscription/quota card. It shows the plan, advertised limits and renewal times without changing the active account. Fresh ZCode sign-ins retain the business and ZCode tokens on the host for available five-hour or weekly resets. API-key-only accounts can read quota; reset status stays unknown without those tokens. Each reset requires confirmation and reuses one idempotency key on retry.

`/zai-status` shows the active account. `/zai-logout` removes it. Configure credentials, endpoints, request limits and scoped secret references in Plugins.

[Reference client](https://github.com/zai-org/ZCode). MIT; see [LICENSE](../../LICENSE).
