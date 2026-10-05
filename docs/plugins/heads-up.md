# Heads Up reference

Private, source-linked notices about overlooked risks in main-agent and subagent work. Local checks run without API calls. Optional independent model review examines bounded assistant output, tool calls/results, and explicit local Git snapshots. The latest main-chat user request can be included separately; this is off by default. Notices are advisory; they never authorize actions, change files, weaken acceptance criteria or establish verification.

## Controls

Open **Session tools > Heads Up** or use `/heads-up review`. New notices appear in one compact expandable row above the composer. **Understood** keeps history, **Dismiss** hides a notice, and **Discuss in chat** explicitly forwards it to the main model. Until discussion, reviewer notices stay in private SQLite state and outside main-model context and compaction.

Reviews drain a bounded number of evidence windows. When more remains, coverage reports it and `/heads-up review` continues from the saved cursor. Discuss is idempotent for a retained notice.

## Review settings and billing

Configure main/subagent scope, cadence, categories, severity, reviewer model/effort/instructions, optional workspace diffs, resource limits and estimated billing in Plugins. Model review defaults off. It needs Execution Recovery for expiring leases and inspectable failures. Requests have no tools, no automatic retry, bounded output and cancellation. Unknown outcomes retain conservative reservations. Supplied prices are estimates, not invoice guarantees.

## Evidence limits

Sources include exact session/event IDs, redacted excerpts and hashes. A Git snapshot may contain pre-existing work and cannot identify its author. Remote execution worlds without a shared-host filesystem mapping cannot provide local Git snapshots. Missing verification and suspicious test edits are review cues, not proof of misconduct. A silent observer does not verify a task.

Commands: `/heads-up status`, `review`, `pause`, `resume`, `cancel`, or `acknowledge|dismiss|discuss NOTICE_ID`. An optional bundled skill explains this boundary to the main model. Disabling the plugin cancels reviews and removes its controls; private notices remain stored.
