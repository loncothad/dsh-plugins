# Execution Recovery

Recover host jobs with expiring leases, bounded retries and inspectable failures. Configure concurrency, deadlines and storage limits in Plugins.

`/runs list` shows jobs; `/runs dead` shows failures that exhausted their retry policy. Unknown outcomes of non-idempotent operations are not retried automatically.

State lives outside model workspaces. Consumers still own credentials, request validation and spending limits.

[Install](https://github.com/loncothad/dsh-plugins/blob/main/docs/installation.md) · [Configuration and commands](https://github.com/loncothad/dsh-plugins/blob/main/docs/plugins/execution-recovery.md).
