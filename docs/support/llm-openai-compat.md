# OpenAI-compatible LLM Adapter reference

A reusable `LlmAdapter` over the OpenAI Chat Completions wire: request
projection, SSE streaming, tool-call block assembly, usage mapping, and
coded error finishes (`AUTH` / `RATE_LIMIT` / `SERVER` / `TRANSPORT`).
Provider plugins configure endpoint, key, catalog, headers, and an
optional live service tier instead of re-implementing the adapter.
