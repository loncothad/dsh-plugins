# Plugin Runtime reference

Shared configuration lifecycle for the DSH plugin packages. The outer Loader entry exposes a complete volatile form; each accepted edit disposes the previous capability generation before validating and mounting the replacement. Native settings writes retain revision fences, persistence, and secret redaction. Capability commands resolve their owning profile entry through `configEntry`.

## Settings and login controls

Custom pages register in `plugins.bundle.config` and `plugins.row.config`. `settings.configure({ auto: false })` suppresses duplicate automatically generated forms. DSH's read-only plugin inventory still enumerates installed components; it has no per-plugin exclusion API.

Login prompts use unique control IDs and independent form ownership inside the Plugins configuration page. Enter submits a text/secret authorization prompt, while IME composition is left untouched. A synchronous operation gate prevents duplicate submissions; status reads captured before a new operation cannot overwrite its state. Codex and Z.AI controls use provider-specific titles and login guidance.

Custom configuration sections can retain a standard editor for a shared field and report scoped validation errors. Both the Save button and submit handler honor those errors. Resetting a dictionary exposes an empty object to custom controls, allowing invalid drafts to be cleared without saving them.

## HTTP identity

Provider HTTP operations use pi-ai’s `pi (<platform> <OS release>; <architecture>)` identity, with `originator: pi` for Codex operations and browser authorization. The format is pinned to source commit `a276dabe57911253350bffb93cb7d7aff6a73261`; it does not change OAuth client IDs, credentials, models, or routing. The adapted browser-safe helper’s MIT notice ships in `THIRD_PARTY_NOTICES.txt`.

Settings use DSH theme tokens and native controls, with section navigation, compact field rows on wide screens, stacked fields on narrow screens, and explicit unsaved/discard state. Saves remain revision fenced.
