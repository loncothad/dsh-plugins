# Media Generation reference

The shared media-generation assembly behind the router plugins (OpenRouter, fal.ai):

- **media.ts**: the vocabulary: modalities (`text`/`image`/`video`/`audio`/`3d`) and each model's advertised inputs and multiple outputs; `acceptsInput` guards edit/transition scenarios per model.
- **harvest.ts**: declared output-field harvesting and normalized artifacts; echoed inputs and arbitrary metadata URLs are excluded.
- **executor.ts**: runs a generator, harvests, downloads/decodes artifacts, writes files; local input paths are inlined as data: URLs; failures classify (`AUTH`, `NO_OUTPUT`, `INPUT`, …).
- **surfaces.ts**: what every router mounts: the `<provider>_generate` tool, the runtime skill, `/<provider>-models`, and `/<provider>-media` with `--output/--image/--video/--audio/--options`.

Pure domain modules import nothing from the harness; consumers inject fetch and file IO for offline tests.

## Workspace execution and publication

Native tools use DSH’s real execution context and canonical output renderer. Files resolve through the admitted agent’s filesystem and stay within its session workspace. Reads use the native bounded-byte API; binary publication requires the filesystem’s explicit shared-host mapping. Read-only policy and unsupported output worlds fail before inference. Custom worlds may supply an `ioFor` adapter. There is no server-working-directory fallback at the tool boundary.

Generation deadlines cover provider calls and downloads. Local/inline inputs, aggregate output bytes, and output file counts are bounded. Downloads use credential-free HTTPS without redirects. A complete bounded artifact batch is downloaded before publication; unique generation IDs and exclusive native file creation prevent overwrite. If a later write fails or cancellation arrives after publication, the executor rolls back files from that generation. Native rollback checks file identity and modification metadata, refuses to delete changed or replaced files, and reports paths requiring cleanup. Publication is sequential, not an atomic filesystem transaction.

The request’s `output` is required for programmatic generation. Tools derive it from the selected catalog model, or choose the configured default with the `output` parameter. Queue mode and OpenRouter response modalities do not depend on model-name guesses or raw `options.modalities`. The tool, skill, and human commands can be disabled independently; skill guidance is suppressed when its tool is disabled.

Text-out/transcription paths and multiple-output catalogs are implemented. Text-only results avoid directory/file publication, including in read-only sessions. Complete input and option schemas, including required fields, nested parameters, arrays, enums and named/repeated assets, are validated before dispatch. Custom `MediaIo.write` adapters must return a rollback receipt for their own publication.

Protected artifacts use a result-owned download capability rather than global authenticated fetch. The OpenRouter video adapter admits only its returned job’s same-origin polling and content paths; the shared executor still bounds the complete downloaded batch before publication.

## Catalog and configuration

`registerMediaCatalog` exposes provider-owned read-only catalog pages through strict Gateway descriptors. `mediaModelControls` from the `./client` export edits the owning form's draft, filters by desired output, searches names/IDs and pages 100 rows at a time. Provider credentials are not included in catalog responses. Catalog loading joins concurrent requests and is bounded by a 60-second deadline and service disposal.

The surfaces merge operator defaults for the exact model with per-call overrides and validate the result before provider dispatch. Both native tools and human commands follow the same path. Defaults cannot replace the selected route, prompt or primary inputs; nested parameters remain available. Option snapshots are detached, bounded finite JSON. Catalog pages and selectors retain/display advertised option constraints.

## Command syntax

Human media commands use `@model` for explicit model selection. Quote paths containing spaces; filesystem backslashes are preserved, including UNC paths. `--options` consumes one bounded JSON object and may precede other flags or prompt text. Use `--` before literal prompt words that begin with `--`. Duplicate output/options flags, unknown flags, malformed JSON and unterminated quotes are rejected before catalog lookup or dispatch. No shell is executed.

```text
/fal-media @model-id-from-catalog --image "source frame.png" --options {"steps":4} edit this picture
/openrouter-media --output text --audio "voice clip.mp3" transcribe this
```

## Output normalization

Artifact normalization visits declared output fields and output containers rather than scanning arbitrary response metadata. Echoed inputs, transcripts and metadata URLs are ignored. File descriptors retain their declared MIME; filename-based inference distinguishes JPEG/WebP, audio formats and supported 3D formats. Opaque outputs without a declared MIME remain binary files instead of inventing an encoding. Inline output deduplication hashes the complete payload, so outputs with identical headers remain distinct. Providers with other response schemas can return explicitly normalized `artifacts`.

Selected models expose advertised scalar parameters as enum selectors, boolean choices, numeric inputs and text inputs. These edit the same default map as the advanced JSON field. Shared validation rejects invalid or oversized defaults and blocks saving until fixed or reset; editing one model preserves other models' options. Current catalog constraints also validate saved values before the form can submit.
