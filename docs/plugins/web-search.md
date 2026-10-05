# Web Search reference

Configure each provider in **Plugins > Web Search**. Each has its own toggle and fields.

| Provider ID | Credentials and billing |
| --- | --- |
| `kagi` | Kagi API key |
| `openrouter` | OpenRouter API key and search model |
| `exa` | Exa API key, or public MCP search when empty |
| `codex` | Active account in ChatGPT Codex; token refresh stays in that provider |
| `openai` | OpenAI API key and Responses search model; separate API billing |

The account shown in the plugin is the account subscription search uses. Change it in ChatGPT Codex. The two OpenAI paths never fall back to each other's credentials. Codex SSE responses are bounded and must finish successfully before results are returned.

Only Exa is enabled by default. Kagi, OpenRouter and OpenAI API require both explicit enablement and a resolved key. Codex requires explicit enablement and an active signed-in subscription account. Separate native model dropdowns read provider catalogs on the host; credentials never enter browser responses. Saved model IDs remain selectable when catalog metadata is unavailable.
