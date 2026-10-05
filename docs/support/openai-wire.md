# OpenAI Wire reference

Pure wire core for OpenAI-style provider plugins: request-body projection and
streaming-response parsing for both the Chat Completions and Responses
protocols, an incremental SSE decoder, and disjoint token-usage mapping.
No DSH imports or network access. Consumers own transport and credentials.

SSE decoding preserves UTF-8 characters across byte chunks and enforces a 4 MiB unsealed-event limit. Invalid UTF-8 fails explicitly. Consumers cancel and release body readers on terminal events or generator disposal.
