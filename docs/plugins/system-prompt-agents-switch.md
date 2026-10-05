# Agents Switch reference

Map a `provider/model` to an instruction file in **Plugins > Agents Switch**. The selected file is appended to the system prompt for that conversation. Relative paths start at its workspace. Exact routes win over model suffix mappings, then the default file applies.

DSH already reads `AGENTS.md`. A custom default file is read by this plugin. Files are re-read on each request, must be regular UTF-8 files and contain at most 16,000 characters.

`/agents-file status` shows the current mapping. `/agents-file PATH` validates and saves a file for the current route. `/agents-file clear` removes that mapping. Saved command changes wait for persistence.
