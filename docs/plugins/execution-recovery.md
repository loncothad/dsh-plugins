# Execution Recovery reference

Durable leased plugin operations backed by a private SQLite worker. **Plugins → Execution Recovery** configures the journal directory, expiring ownership, bounded concurrency and consumer deadline. `/runs list` and `/runs dead` show sanitized operation identities, status, attempts and failure reasons. They never return credential values or arbitrary consumer payloads.

Consumers submit a stable operation identity and non-secret payload references. Successful results can be recovered without dispatching the operation again. Native admission is bounded; live owners renew their lease, and stale owners cannot publish. Failed/cancelled work becomes an inspectable dead letter. Unknown external side effects are not replayed automatically. Consumers retain their own credential authority, validation, idempotency and monetary reservations; a lease grants none of those permissions.

The journal belongs outside model-writable workspace paths, inside the isolated deployment home. Linux requires a private 0700 directory; Windows relies on the deployment’s filesystem access control. Disposal cancels owned work, drains consumers and closes the worker. The shared journal enforces finite pending-channel, active-job and retained-record quotas.
