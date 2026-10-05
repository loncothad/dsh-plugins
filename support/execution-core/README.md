# Execution Core

Shared deterministic configuration, evidence judgments, structured refusal reasons and lease-based job recovery.

Configuration precedence is defaults, environment, user, then admitted run overrides. Jobs use fencing tokens and dead-letter inspection. Unknown non-idempotent outcomes are not automatically retried.

[API and implementation reference](https://github.com/loncothad/dsh-plugins/blob/main/docs/support/execution-core.md).
