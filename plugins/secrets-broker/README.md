# Secrets Broker

Lend scoped credentials to trusted host tools without exposing raw secrets to the model or browser. Configure references, consumers, environments and limits in Plugins; `/secrets` shows metadata only.

Supports 1Password CLI and Vault KV v2, Linux Secret Service, and Windows PowerShell SecretManagement. Set up the vault's own authentication first. macOS is unsupported.

Pair with Environment Isolation and native sandboxing. Trusted third-party code and unrestricted shells remain outside the broker's isolation boundary.

[Install](https://github.com/loncothad/dsh-plugins/blob/main/docs/installation.md) · [Configuration and commands](https://github.com/loncothad/dsh-plugins/blob/main/docs/plugins/secrets-broker.md).
