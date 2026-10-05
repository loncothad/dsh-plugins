# Built-in Controls reference

Open **Plugins → Built-in Controls** or **Settings → Built-in plugins → Controls**.

- **Runtime components** uses DSH’s native enable/disable API. Required management and control-page UI components are locked with a reason. Application, restart and overridden states are reported separately.
- **Agent presets** edits one component in its owning preset through the public configuration editor. Other entries and settings are preserved. Stale edits are rejected. Failed activation restores the previous configuration. Changes apply to new or resumed chats; running chats retain their current preset revision. Restore default restores the inherited disabled flag or platform condition.
- **Skills** disables exact names through public provider precedence and invocation flags. Both model and human loading are blocked in host and agent scopes. Catalogs can be inspected per open chat. Existing conversation instructions and the tools referenced by a skill remain unchanged.

Switches persist in the active profile. Search, keyboard tabs, loading/error feedback and mobile layouts use native DSH controls. No upstream modifications, registry replacement or DOM hiding. The diagnostic inventory remains available. All mutations require the authenticated human Gateway; this plugin exposes no management tool to models.
