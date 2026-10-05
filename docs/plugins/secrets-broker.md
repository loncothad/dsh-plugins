# Secrets Broker reference

Host-only credential borrowing for explicitly configured consumers and independent dev/staging/prod references. **Plugins → Secrets Broker** configures references, provider locators, consumer allowlists, deadlines, concurrency, byte limits and bounded redaction history. `/secrets` exposes metadata only. There is no raw-secret tool or browser RPC method.

## Secret providers

Supported public protocols: [1Password CLI read](https://www.1password.dev/cli/reference/commands/read), [Vault KV v2 read](https://developer.hashicorp.com/vault/api-docs/secret/kv/kv-v2), Linux Secret Service `secret-tool lookup`, and Windows [PowerShell SecretManagement Get-Secret](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.secretmanagement/get-secret?view=ps-modules). Linux and Windows are supported; macOS is outside this package’s platform contract. Third-party authentication is operator-owned, using a desktop/CLI vault session or environment-specific bootstrap variables. No cross-environment token fallback is used.

## Lease and retrieval boundary

Trusted host consumers receive frozen credential values only while their operation lease is valid. Reference environment and consumer allowlists are checked before retrieval; deployment identity is rechecked before and after execution. Expiry/cancellation rejects late output. Retrieval uses HTTPS or fixed CLI arguments with no shell and a restricted environment. PowerShell locators travel through environment variables, never executable interpolation. Provider stderr and failure bodies never enter diagnostics. Secret sizes, lease count and remembered redaction values are bounded.

## Limits

JavaScript strings cannot promise secure memory erasure. Redaction history remains in bounded host memory until disposal so late ordinary text can be masked. Trusted third-party plugins and deliberately enabled unrestricted shells remain outside this credential isolation boundary; use Environment Isolation, native sandboxing and Policy Engine rules. Real external vault sign-ins require operator setup and are qualified separately from protocol fixtures.
