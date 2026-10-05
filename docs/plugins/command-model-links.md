# Model Links reference

Declare equivalent `provider/model` routes in **Plugins > Model Links**. Add a group, choose its routes from the model catalog and save. Cycling follows that order and changes the receiving conversation through DSH's native model selection API.

- `/model-links`: list groups.
- `/model-link codex/gpt-6-luna=openrouter/openai/gpt-6-luna`: merge a group.
- `/model-unlink provider/model`: remove a route.
- `/model-cycle`: choose the next linked route.

Command edits wait for persistence and reject concurrent configuration changes. Use Fallback Router for automatic recovery.
