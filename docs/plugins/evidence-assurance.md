# Evidence Assurance reference

Evidence contracts separate model output from permission and task completion. **Plugins → Evidence Assurance** configures independent sources, freshness, database reads, deterministic verifier recipes, optional separate model validation, human review, goal completion, resource limits, tools and the output-state skill. The conversation panel shows explicit states, missing checks, exact target hashes, receipt history and workflow criteria.

`/workflow start CONTRACT :: CRITERIA` declares acceptance criteria. `/assurance status` inspects the current target. `/assurance verify CONTRACT` runs only operator-owned recipes; `/assurance approve TARGET_HASH` records human review. `/workflow complete` records completion only after the contract passes. `evidence_verdict` and `verify_evidence` expose metadata to the model. No model-facing tool can manufacture human review or arbitrary verifier code.

## Receipt validity

Private durable receipts name the actual workspace fingerprint, current criteria, human corrections and declared contract configuration. Target changes invalidate their applicability. Source freshness is checked against the original observation time; cached verifier and source reads are never relabeled as fresh. Independent publisher groups and content hashes prevent duplicate sources from satisfying a count; freshness and required verifier IDs are checked deterministically. The output vocabulary is verified, unverified and insufficient_evidence. Verification means satisfying the declared checks, not a claim of universal correctness. A model-verifier pass alone remains unverified.

Verifier executables must be absolute and outside the mutable workspace. Arguments are literal values; exact {workspace} arguments provide a path without code interpolation. Credentials use explicit Secrets Broker bindings and a restricted child environment. Output is bounded, hashed and redacted; tools return verdict metadata. Leased recovery preserves outcomes without blindly resubmitting API validation. Real verifier models use the registered DSH catalog and their own provider credentials.

## Goal completion

Regular model-driven goal completion is guarded. Plan & Goals integrates the same authority before ordered-step approval. Native human goal controls remain a separate operator authority; an operator’s manual status change does not turn failed evidence into verified output or complete this plugin’s workflow contract. Failed configuration leaves completion authority closed.
