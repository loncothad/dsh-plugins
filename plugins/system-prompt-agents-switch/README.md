# Agents Switch

Append an instruction file for the selected `provider/model`. Configure exact routes, model suffixes and a default file in Plugins. Relative paths start at the chat workspace; files are re-read for each request.

`/agents-file status` shows the mapping. `/agents-file PATH` saves one for the current route; `/agents-file clear` removes it. DSH already loads `AGENTS.md`, so use a separate file for additional instructions.

[Install](https://github.com/loncothad/dsh-plugins/blob/main/docs/installation.md) · [Configuration and commands](https://github.com/loncothad/dsh-plugins/blob/main/docs/plugins/system-prompt-agents-switch.md).
