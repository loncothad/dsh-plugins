# Workspace Safety

Start isolated Git work sessions with `/workspace start REPOSITORY`. Configure repositories, branch prefix and external worktree/checkpoint roots in Plugins. The original branch, index and uncommitted files are preserved.

Use `/checkpoint create`, `/checkpoint list`, `/checkpoint diff ID` and `/checkpoint restore ID ABSOLUTE_EMPTY_DIRECTORY`. Checkpoints live outside the workspace; restore refuses nonempty destinations.

Snapshots omit common credential files and protect workspace content, not complete Git history. Storage limits stop admission rather than silently deleting recovery data.

[Install](https://github.com/loncothad/dsh-plugins/blob/main/docs/installation.md) · [Configuration and commands](https://github.com/loncothad/dsh-plugins/blob/main/docs/plugins/workspace-safety.md).
