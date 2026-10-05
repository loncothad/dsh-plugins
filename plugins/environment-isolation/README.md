# Environment Isolation

Keep dev, staging and production in separate deployment homes. Set `DSH_HOME` to `ROOT/dev`, `ROOT/staging` or `ROOT/prod` before launching DSH. `/environment prepare ENV` creates an empty home without copying credentials or data.

Configure identity, overrides, limits and shell admission in Plugins. `/environment status` shows the resolved configuration; `/environment limit KEY VALUE` lowers a run limit.

Shell access is off by default. Unrestricted code still requires native OS sandboxing.

[Install](https://github.com/loncothad/dsh-plugins/blob/main/docs/installation.md) · [Configuration and commands](https://github.com/loncothad/dsh-plugins/blob/main/docs/plugins/environment-isolation.md).
