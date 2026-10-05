# Execution Core reference

Shared host contracts for deterministic configuration, evidence judgments, policy decisions and recovery. Configuration uses whole-field defaults → environment → user → explicitly admitted run overrides with provenance and a canonical fingerprint. Invalid JSON, reserved keys and unknown overrides fail.

Evidence judgments use verified, unverified and insufficient_evidence. Fresh receipts must name the exact target; duplicate origins and mirrored content do not count as independent sources. A model-verifier opinion alone cannot certify consequential work. Structured refusal kinds distinguish safety, permissions, evidence, capability and transient failure.

LeaseJournal owns SQLite transitions, fencing tokens, expiring ownership, bounded admission, retries and dead-letter inspection. Non-idempotent operations with unknown outcomes do not retry automatically. Expired workers cannot publish or renew, and repeated submission must retain the same operation identity. Callers own the database connection and must use the appropriate worker or bounded host lifetime.
