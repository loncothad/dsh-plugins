# fal Media reference

[fal.ai](https://fal.ai) as a dsh media provider: the live paged generation registry (image, video, audio, 3d) with advertised transition categories: `text -> image`, `text+image -> image` (editing), `image -> video`, `audio -> audio`, and more. Speech-to-text, audio/image/video-to-text, and vision categories are included; training endpoints remain excluded.

**Surfaces**: the `fal_generate` tool (prompt + `images`/`video`/`audio` inputs + options), the runtime skill, `/fal-models [image|video|audio|3d|<id>]` (transitions + price per model), and `/fal-media [@model] <prompt> [--output text|image|video|audio|3d] [--image PATH] [--video PATH] [--audio PATH] [--options JSON]`. Wrong-kind inputs are refused per model.

**Execution**: image/3d POST `fal.run/{model}` (sync); video/audio default to the queue (`queue.fal.run` submit → poll → collect), overridable per modality. Inputs map to `image_url(s)`/`video_url`/`audio_url`; caller options merge on top, so per-model schema fields win. Declared output fields are normalized and published under `outDir`; echoed inputs and metadata URLs are excluded.

**Catalog**: discovered through fal's documented model API, with cursor pagination and a ten-minute host cache. Input and output OpenAPI schemas are retrieved on demand. Queue result schemas are distinct from queue submission/status envelopes. There is no invented offline model list; unavailable metadata remains unavailable. Selected-model pricing comes from the authenticated pricing API and never exposes the key to the browser.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `$FAL_KEY` | key |
| `outDir` | `fal-media` | output directory |
| `imageExecution` / `videoExecution` / `audioExecution` | sync / queue / queue | `sync` or `queue` |
| `registryPages` | `256` | traversal ceiling; follows the live last-page metadata |
| `imageModel` / `videoModel` / `audioModel` / `meshModel` |: | explicit output defaults |
| `meshExecution` | sync | execution mode for 3D models |
| `textModel` / `textExecution` |: / queue | text-output media default and execution mode |
| `mediaEnabled` | true | enable media capabilities |
| `mediaTools` / `mediaSkills` / `mediaCommands` | true | control each native surface |
| `timeoutMs` / `pollMs` | 300000 / 2000 | total deadline and queue polling interval in milliseconds |
| `maxInputBytes` / `maxOutputBytes` / `maxFiles` | 64 MiB / 128 MiB / 8 | aggregate generation resource limits |

## Execution boundaries

Queue callbacks must remain on the configured queue origin, and authenticated requests refuse redirects. Execution mode follows the selected catalog output. Media output stays in the admitted session workspace and requires a writable, explicitly mapped filesystem. Asset-only transcription returns text without writing files. The documented speech-to-text `output` field is normalized as text.

Transcription mapping follows [fal’s speech-to-text contract](https://fal.ai/models/fal-ai/speech-to-text/api).

## Model chooser and options

Media defaults use output-filtered model selectors in the native Plugins form. Catalog pages come from the authenticated host Gateway and share the provider's cached generation catalog. Search and 100-model pagination expose names, IDs, advertised inputs/outputs and prices. Saved selections outside the current page remain intact. Changes apply with the rest of the configuration, and selectors remain available when media generation surfaces are disabled. Catalog loads have a 60-second total deadline and stop when their service generation is disposed.

`mediaModelOptions` saves option defaults by exact model ID, for example `{"vendor/video":{"duration":4,"resolution":"720p"}}`. Tool arguments and `/fal-media --options` override individual keys. The merged options are validated against advertised constraints before dispatch. Defaults cannot replace routing, prompts or primary source inputs. Model selectors display advertised parameter keys and allowed values; fal models without published constraints retain provider-specific JSON options. Defaults accept bounded finite JSON only (32 KiB per model, 512 KiB total). Advertised scalar parameters have typed controls beside each selected model; advanced JSON covers additional provider-specific settings. Invalid drafts block configuration saves.

Explicit command model IDs require the `@` prefix. Quote source paths containing spaces; `--options` accepts one JSON object anywhere among the arguments. Text output supports transcription and captioning with the selected model.

## Contracts and toggles

`fal_model_info` browses models and returns one full input/output contract. `fal_generate` validates the complete body, supports named/repeated assets, and publishes bounded results inside the admitted workspace. `--asset JSON` and `--3d PATH` are available in `/fal-media`. Tools, commands, skills, provider execution and each media task can be disabled separately. DSH file-generation tools do not expose realtime-only, streaming-only or webhook-only contracts. Generated files receive native image/file references where the execution profile supplies attachment storage.

The model chooser shows “Released on fal” from the official catalog’s `metadata.date` (model creation), separately from `updated_at`. It defaults to newest first across the full catalog before paging. Unknown dates appear last. Name and provider order are also available; original model release dates outside fal are not inferred. See [fal’s model metadata contract](https://fal.ai/docs/platform-apis/v1/models).
