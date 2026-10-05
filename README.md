# DSH Plugins

Model providers, media tools and workflow plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Targets **DSH 0.2.0-rc.2** and **Node 24**. MIT licensed.

Choose from OpenRouter, ChatGPT Codex, Z.AI and fal; add search, model routing, goals, private summaries, evidence compaction, policy controls or isolated workspaces. See the [plugin catalog](docs/catalog.md) for all 27 plugins. Shared support libraries install as dependencies.

## Install

Build the workspace, then add the plugin to your DSH profile:

```sh
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile web add /absolute/path/to/dsh-plugins/plugins/provider-openrouter
```

Open **Plugins**, select the plugin, configure it and save. Credentials stay on the host. A blank secret field retains its value; clearing is explicit.

The [installation guide](docs/installation.md) covers tarballs, provider login and host limitations. Packages are being prepared for release; building or packing does not publish them.

## Contribute

Use `pnpm check:fix` for Biome formatting and safe lint fixes, then `pnpm verify`. Read the [development guide](docs/development.md) for reference setup and checks.

[Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md) · [License](LICENSE)
