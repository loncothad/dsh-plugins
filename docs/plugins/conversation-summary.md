# Conversation Summaries reference

Conversation Summaries delivers incremental, human-facing cards in native DSH chat. External model output lives only in the private recovery journal. Private presentation snapshots carry a scoped reference; the authenticated human UI fetches the body separately: it never becomes an assistant message, injected context, compaction evidence, or the output of a model-facing tool. Cards show source, trigger, covered event range, completed turns, time and remaining coverage, with expandable Markdown and copy controls. Even raw session-log queries cannot retrieve external summary text.

## Controls

Use `/summary now`, `/summary status` and `/summary cancel`, or **Session tools > Summaries**. **Plugins → Conversation Summaries** configures local transcript digests or any registered summary model, periodic delivery every N completed turns, any registered decision model, prompts, context fallback, output limits, deadlines, concurrency and durable per-session call limits. Automatic delivery defaults to off. Model generation and decision modes send only the selected evidence window to their providers and may incur charges. Credentials remain in the selected provider’s configuration. These resource limits do not estimate or cap monetary billing.

The optional `request_conversation_summary` tool acknowledges a signal and schedules delivery after the current turn closes. It never returns external summary text. An independently toggleable bundled skill teaches appropriate signaling when the tool is enabled. Disabling a capability unregisters it and prevents direct execution.

## Recovery and coverage

External summary and decision calls require Execution Recovery. They acquire fenced leases and retain failed or unknown outcomes as inspectable dead letters. A completed auxiliary result can be reused after interrupted publication without paying for another generation. `/runs dead` inspects failures; there is no blind automatic retry of an unknown API outcome. Local transcript digests remain available without an auxiliary model worker.

Coverage advances through a contiguous prefix only after successful generation. Single events exceeding the input limit fail visibly; no evidence is silently skipped. Local digests label excerpts; model summaries are attestations, not verified facts. Completed model output is required: tool calls, empty output, truncation, malformed decisions and oversized output fail. Failed calls consume a reserved slot but leave coverage unchanged. Queue admission is limited to 128 sessions, jobs coalesce per session, and disposal cancels owned work. A private SQLite worker preserves coverage, receipts and reservations through revision-fenced snapshots. Original session inputs are flushed before coverage is committed. Snapshot publication is acknowledged only after its durable transaction; interrupted publication reuses the scoped completed job. UI reads are authenticated and bounded. No unsupported custom events are appended to the native session log.

## Context boundary

The incremental window reads original message and tool events, retaining chronological corrections; attachments appear as omitted modality markers and their bytes are never sent. Settings, credentials, request headers and prior summary cards are excluded. A failed automatic decision is not retried at the same closed-turn boundary; another completed turn or manual action can retry. No upstream DSH code is changed.
