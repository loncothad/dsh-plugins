# Evidence Store

Worker-owned SQLite storage for immutable evidence, deduplicated spans, original-text search, source-linked atoms and replayable request manifests.

Includes bounded extraction jobs, independent cold-object compression and retention that preserves shared live objects. This library does not activate a DSH compactor.

[API and implementation reference](https://github.com/loncothad/dsh-plugins/blob/main/docs/support/evidence-store.md).
