# Z.AI GLM

Sign in through ZCode or add a coding-plan API key in Plugins. Name accounts, choose the active one and inspect subscription type, remaining quota and renewal times for each account.

ZCode accounts can expose available resets, each requiring confirmation. API-key-only accounts can read quota but may lack reset credentials.

`/zai-status` shows the active account; `/zai-logout` removes it. The separate `zai-coding-cn` route uses its own configured key.

[Install](https://github.com/loncothad/dsh-plugins/blob/main/docs/installation.md) · [Configuration and commands](https://github.com/loncothad/dsh-plugins/blob/main/docs/plugins/provider-zai.md).
