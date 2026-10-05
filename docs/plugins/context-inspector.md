# Context Inspector reference

Read-only native conversation inspection of the actual last main-agent request in the current host generation. **Plugins → Context Inspector** configures message-row and text-preview bounds, aggregate preview size and retention-unit visibility. Text previews default to off.

The conversation inspector shows route identity, advertised context capacity, native token pressure and its estimation basis, a separately labeled UTF-8 envelope heuristic, message/block structure, tool names, current protocol-unit importance ranking and recorded compaction ranges. Unknown values remain unknown. It does not infer exact provider wire tokenization or confidence from counts. Retention scores are selection hints; mandatory content and call/result dependencies remain explicit.

Auxiliary model calls, external summary bodies, credential stores and authorization headers are excluded. Optional previews include only text already present in the main request and apply available Secrets Broker redaction. The authenticated human Gateway owns the inspector; no model-facing inspection tool imports hidden presentation content. Weakly owned snapshots disappear with their session/host generation. Native history and current surface metadata remain available when no request has yet been captured.
