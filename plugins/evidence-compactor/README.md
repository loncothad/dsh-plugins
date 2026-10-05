# Evidence Compactor

Compact chat context while preserving original evidence for retrieval. Retention prioritizes constraints, corrections, decisions, failures and unfinished work over duplicate reads and verbose successful output.

Configure retention, request budgets and optional extraction in Plugins. Extraction is off by default; it uses the selected provider's credentials and requires explicit permission to send evidence.

`evidence_search` and `evidence_read` retrieve source-linked originals. Standard/PTC presets use the replacement after reopening. Disabling the plugin leaves native basic compaction available and retains archived evidence.

[Install](https://github.com/loncothad/dsh-plugins/blob/main/docs/installation.md) · [Configuration and commands](https://github.com/loncothad/dsh-plugins/blob/main/docs/plugins/evidence-compactor.md).
