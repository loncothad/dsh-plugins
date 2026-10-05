# Decision Models

Use typed choice, score and yes/no decisions for routing or classification. Configure OpenRouter, Cloudflare, TypeSafe or a registered text model in Plugins.

`/decision Question :: choice | choice :: state` tries a choice; `/decision status` shows the backend. Tools expose `decision.ask` and `decision.evaluate`. Conversation Summaries can use the same backend.

Cloudflare requires Cloudflare Decisions; OpenRouter uses its provider's credentials. Decisions remain unverified and cannot authorize actions or establish completion.

[Install](https://github.com/loncothad/dsh-plugins/blob/main/docs/installation.md) · [Configuration and commands](https://github.com/loncothad/dsh-plugins/blob/main/docs/plugins/llm-decision-models.md).
