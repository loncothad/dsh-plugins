# Workspace Safety reference

Isolated Git work sessions and external immutable file checkpoints. **Plugins → Workspace Safety** configures named repositories, branch prefix, separate worktree/checkpoint roots, raw-repository enforcement and resource quotas. The conversation panel starts an isolated native session, creates checkpoints and inspects history.

## Worktrees

`/workspace start REPOSITORY` creates a unique `dsh/ENVIRONMENT/IDENTITY` branch, copies current tracked and non-ignored working files, and opens a native agent with that worktree as its immutable cwd. The raw repository’s current branch, index and uncommitted files are preserved. Model tools are blocked in configured raw repositories until an isolated session is opened. Native DSH rc.2 has no composable pre-creation cwd hook; this plugin uses public session creation and navigation instead of mutating the host factory or an existing session’s cwd. Branch creation and workspace routing are automatic within this entry point.

## Checkpoints

`/checkpoint create`, `/checkpoint list`, `/checkpoint diff ID`, and `/checkpoint restore ID ABSOLUTE_EMPTY_DIRECTORY` protect workspace content outside the working repository. File objects and manifests are integrity-checked, capture rechecks actual bytes before publication, and Linux fsyncs files/directories. Windows directory fsync is unavailable through this Node interface; power-loss behavior requires filesystem qualification. Restore publishes into an empty directory and refuses existing nonempty work. Common credential files are explicitly omitted. These snapshots restore workspace content, not complete Git object history or remote repository configuration.

## Storage and execution boundaries

Storage and worktrees must be outside raw repositories; deployment homes must be outside model workspaces. Snapshot quotas stop admission rather than silently deleting recovery data. Configuration replacement disposes owned agent handles but preserves worktrees and checkpoints; reopen their native sessions to continue. Generic shell isolation requires the native OS sandbox and Environment Isolation/Policy Engine controls. Third-party trusted host code remains outside this filesystem admission boundary.
