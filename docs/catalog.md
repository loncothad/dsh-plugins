# Package catalog

Install plugins into a DSH profile, then configure them on the **Plugins** page. Support libraries install as dependencies. See [installation](installation.md).

## Plugins

| Plugin | Purpose |
| --- | --- |
| [Built-in Controls](plugins/builtin-controls.md) | Enable or disable native runtime plugins, preset components and skills from **Plugins > Built-in Controls**, or **Settings > Built-in plugins > Controls** |
| [Model Links](plugins/command-model-links.md) | Group equivalent `provider/model` routes in **Plugins > Model Links** and choose their order |
| [Context Inspector](plugins/context-inspector.md) | Inspect the last main-model request: its route, context capacity, messages, tools and compaction ranges |
| [Conversation Summaries](plugins/conversation-summary.md) | Show incremental summaries in private chat cards |
| [Environment Isolation](plugins/environment-isolation.md) | Keep dev, staging and production in separate deployment homes |
| [Evidence Assurance](plugins/evidence-assurance.md) | Define completion criteria and evidence requirements: independent sources, fresh reads, deterministic checks, a separate verifier model or human review |
| [Evidence Compactor](plugins/evidence-compactor.md) | Compact chat context while preserving original evidence for retrieval |
| [Execution Recovery](plugins/execution-recovery.md) | Recover host jobs with expiring leases, bounded retries and inspectable failures |
| [Fallback Router](plugins/fallback-router.md) | Choose a primary route or provider wildcard, then an ordered list of fallback models and reasoning efforts in **Plugins > Fallback Router** |
| [Heads Up](plugins/heads-up.md) | Show private risk notices alongside chat |
| [Decision Models](plugins/llm-decision-models.md) | Use typed choice, score and yes/no decisions for routing or classification |
| [Path Globs](plugins/path-globs.md) | Expand file globs in user messages and preview matches with `/glob preview PATTERN` or **Session tools > Glob preview** |
| [Plan & Goals](plugins/plan-goals.md) | Use `/goal IDEA` for adaptive work or `/sisyphus IDEA` for an ordered plan |
| [Policy Engine](plugins/policy-engine.md) | Decide whether an action may run through explicit rules, evidence requirements and human approval |
| [Cloudflare Decisions](plugins/provider-cloudflare-decisions.md) | Use Clef or Clef Flash for typed choice, score and yes/no decisions, with optional image input |
| [fal Media](plugins/provider-fal.md) | Generate images, video, audio and 3D assets, or run transcription and media understanding through fal's advertised models |
| [ChatGPT Codex](plugins/provider-openai-codex.md) | Use a ChatGPT Codex subscription as a DSH model provider |
| [OpenRouter](plugins/provider-openrouter.md) | Use OpenRouter chat and media models |
| [Z.AI GLM](plugins/provider-zai.md) | Sign in through ZCode or add a coding-plan API key in Plugins |
| [Secrets Broker](plugins/secrets-broker.md) | Lend scoped credentials to trusted host tools without exposing raw secrets to the model or browser |
| [Devenv Shell](plugins/shell-devenv.md) | Run shell commands in the nearest project with `devenv.nix` or `devenv.yaml` |
| [Nix Flake Shell](plugins/shell-nix-flake.md) | Run shell commands inside the nearest `flake.nix` with `nix develop` |
| [Nix Package Skills](plugins/skill-nix-packages.md) | Load skills from configured roots and read their `metadata.nix-packages` declarations |
| [Agents Switch](plugins/system-prompt-agents-switch.md) | Append an instruction file for the selected `provider/model` |
| [System Prompt Replace](plugins/system-prompt-replace.md) | Replace DSH's system-prompt sections with one inline prompt or file |
| [Web Search](plugins/web-search.md) | Configure Exa, Kagi, OpenRouter, OpenAI API or ChatGPT Codex search in Plugins |
| [Workspace Safety](plugins/workspace-safety.md) | Start isolated Git work sessions with `/workspace start REPOSITORY` |

## Support libraries

| Library | Purpose |
| --- | --- |
| [Decision Core](support/decision-core.md) | Shared typed choice, score and yes/no contracts, validated requests and answers, and provider registration with an owned lifetime |
| [Evidence Harness](support/evidence-harness.md) | Connect DSH's public provider, session and profile APIs to Evidence Store |
| [Evidence Store](support/evidence-store.md) | Worker-owned SQLite storage for immutable evidence, deduplicated spans, original-text search, source-linked atoms and replayable request manifests |
| [Execution Core](support/execution-core.md) | Shared deterministic configuration, evidence judgments, structured refusal reasons and lease-based job recovery |
| [OpenAI-compatible LLM Adapter](support/llm-openai-compat.md) | Adapt native DSH requests to OpenAI Chat Completions: streaming, tool calls, usage and coded errors |
| [Media Generation](support/media-gen.md) | Shared media contracts, catalog controls, tools, skills and slash commands for fal and OpenRouter |
| [OpenAI Wire](support/openai-wire.md) | Protocol utilities for OpenAI-style Chat Completions and Responses: request projection, streaming parsers, incremental SSE decoding and usage mapping |
| [Plugin Runtime](support/plugin-runtime.md) | Shared revision-fenced configuration, native Plugins pages, login controls and capability lifecycle management |
