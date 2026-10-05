# Installation and configuration

These packages target DSH `dsh-v0.2.0-rc.2` and Node 24. Choose an installable bundle from the [catalog](catalog.md). Support libraries are dependencies; do not activate them separately.

## From source

Run from the repository root with pnpm 11.9.0:

```sh
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile web add /absolute/path/to/dsh-plugins/plugins/provider-openrouter
```

Replace the final path with the plugin you want. The build produces Host ESM, declarations, browser factories and workers. Compiler qualification additionally requires the upstream reference described in the [development guide](development.md).

## From a prepared release candidate

Use the verified tarball for the plugin and install its coordinated support dependencies from the same candidate. An independent npm consumer can install local tarballs before registry publication; see [release preparation](release.md). There are no compatibility aliases between experimental package names.

## Configure in DSH

Open **Plugins**, select the bundle, edit its settings and save. Changes reload the owned capability after disposing the previous generation. Concurrent edits are revision fenced; reload or discard explicitly after a conflict.

Leaving a secret field blank retains the stored credential. Clear it explicitly to remove the override. Providers may also read documented environment variables or scoped Secrets Broker references. Credentials and grants stay on the host.

Provider setup:

| Plugin | Authentication |
| --- | --- |
| [OpenRouter](plugins/provider-openrouter.md) | API key or `OPENROUTER_API_KEY` |
| [fal](plugins/provider-fal.md) | API key or `FAL_KEY` |
| [ChatGPT Codex](plugins/provider-openai-codex.md) | Browser or device authorization; device login works with remote hosts |
| [Z.AI](plugins/provider-zai.md) | ZCode sign-in or coding-plan API key |
| [Cloudflare Decisions](plugins/provider-cloudflare-decisions.md) | Cloudflare account ID and Workers AI token |

A browser's localhost OAuth callback reaches the browser's machine. Prefer Codex device authorization when DSH runs elsewhere. Login attempts can be cancelled from the Plugins page; host grants are not sent back to the browser.

## Host limits

DSH rc.2 retains its diagnostic **Built-in plugins** inventory. It has no supported per-plugin exclusion API. Custom settings suppress duplicate generated forms through the public Settings API. [Built-in Controls](plugins/builtin-controls.md) manages supported runtime, preset and skill switches; protected host components and instructions already loaded into history remain visible limits.

Devenv and Nix shell plugins require a POSIX execution host. Windows can use WSL. Secrets Broker supports Linux and Windows, not macOS. Use independent deployment homes and native OS sandboxing for environment boundaries; trusted host plugins have host authority.
