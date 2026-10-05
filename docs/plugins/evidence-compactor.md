# Evidence Compactor reference

## Activation and lifecycle

The plugin installs standard/PTC compaction replacements through the public profile editor. It removes competing stock compaction, pruning and offload entries while preserving unrelated rows and native backend settings. Existing agents keep their preset revision until reopened.

One locked SQLite worker owns each canonical workspace; session ledgers remain isolated. Disabling the bundle withdraws capture, retrieval and extraction. Configured runtimes fall back to DSH's public `BasicCompactionEngine`, so new and existing sessions and `/compact` remain usable. Re-enabling restores the evidence owner. Disabling does not delete archived originals.

## Retention

Importance-based retention is the default. Deterministic hints prioritize human constraints and corrections, decisions, failed approaches, unresolved work, file mutations and failed tools/tests. Duplicate reads and successful verbose output receive lower priority. Failed tool output is not reduced to beginning/end excerpts. Recency mode selects chronological eviction instead.

Scores are retention heuristics, not confidence or permission. Protocol units remain indivisible; current controls stay mandatory and original bytes stay archived. Extraction proposes source-linked categories. Readable atoms prefer constraints, decisions, failed attempts and open items over observations or intermediate hypotheses.

## Optional extraction

Extraction is disabled by default. Select a registered provider/model, configure credentials in that provider, and explicitly allow evidence egress. Advertised input/output prices or explicit permission for unknown billing are required by the extraction budget policy.

A route without advertised capacity needs `extractionFallbackContextWindow`, separate from the main-model fallback. The complete extraction input, fixed 1,500-token output reservation and `safetyTokens` must fit before dispatch. Controls, policy and source state are rechecked before publication.

## Request budgeting and replay

The backend guards the complete native request using route-aware SDK pressure and UTF-8 envelope accounting. These are conservative heuristics, not exact provider tokenization. Unknown main-model capacity needs an operator fallback. Instructions, pins, the latest human input and open dependency groups stay mandatory; mandatory overflow fails explicitly. Historical memory has a separate bounded budget.

Under automatic pressure, the backend first masks up to eight bulky closed tool observations. It preserves call/result identity, errors, non-text blocks and UTF-8-safe original beginnings/endings, with evidence IDs for omitted bytes. Capture and a prospective manifest are durable before replacement. DSH rebuilds the request; tool actions are not rerun. Manual region compaction keeps complete groups intact.

Submitted-request manifests retain canonical replay recipes with captured span references, headers and tool definitions. The canonical form excludes `AbortSignal` and volatile message/checkpoint IDs. A prospective manifest describes the planned request before its checkpoint ID; the submitted manifest records the actual canonical request. Reopened ledgers recover evidence links from replacement provenance.

## Retrieval and storage

`evidence_search` and `evidence_read` derive workspace/session scope from the admitted agent. They return original quotes, attribution and adjacent-span IDs; arguments cannot select another scope. Retrieval does not establish approval or completion.

[Evidence Store](../support/evidence-store.md) describes compression, deletion invalidation, retention and reclamation. [Evidence Harness](../support/evidence-harness.md) describes native capture and request assembly. Candidate-specific qualification results belong with release artifacts, not this behavior reference.
