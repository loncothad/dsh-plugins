# OpenRouter reference

OpenRouter as a first-class dsh provider, catalog split by output:

- **Chat**: every text model from the public `/api/v1/models` (TTL-cached; only real observations retained after refresh failure): display names, context windows, per-model reasoning efforts (the picker's effort selector), and pricing (`$X/M in · $Y/M out` rides each description). Alias and retired entries filtered.
- **Media**: image-output (Gemini image, GPT Image) and audio-output (GPT Audio, Lyria) models behind the shared media surfaces; image editing passes inputs as multimodal parts; video understanding uses documented `video_url` parts; video generation uses its separate asynchronous endpoint.

**Upstream providers**: the Plugins page and an additive composer control select real upstream endpoint slugs per canonical model ID. Selections apply to that model in all sessions, override the global `/openrouter-provider [slug|off]` pin, and disable fallback outside the selected endpoint. Chat and media share these preferences. The control reads public model endpoints, provider privacy links, and the ZDR eligibility list. It shows USD/M token prices, p50 latency and throughput over 30 minutes, and one-day uptime. Missing values and unconfirmed retention remain unknown. `zeroDataRetention` and `denyDataCollection` enforce privacy preferences in every outgoing request. See [endpoint metadata](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model) and [routing semantics](https://openrouter.ai/docs/guides/routing/provider-selection).

**Commands**: `/openrouter-models [text|image|video|audio|<id>]`, `/openrouter-media [@model] <prompt> [--output text|image|video|audio] [--image PATH] [--video PATH] [--audio PATH] [--options JSON]`, `/openrouter-provider`.

Open **Plugins → OpenRouter** to configure the provider. API keys are redacted; leaving the field blank retains the existing credential.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `$OPENROUTER_API_KEY` | key |
| `endpoint` | `https://openrouter.ai/api/v1/chat/completions` | override |
| `extraModels` | `""` | comma-separated extra chat ids |
| `pinnedProvider` | `""` | volatile: globally pinned upstream |
| `modelProviders` | `{}` | canonical model ID → exact upstream endpoint slug |
| `zeroDataRetention` | `false` | route only to ZDR endpoints |
| `denyDataCollection` | `false` | exclude providers that collect data |
| `mediaOutDir` | `openrouter-media` | generated media directory |
| `audioVoice` / `imageModel` / `audioModel` |: | media defaults |
| `mediaEnabled` | true | media capabilities independently of chat routing |
| `mediaTools` / `mediaSkills` / `mediaCommands` | true | control each native media surface |
| `mediaTimeoutMs` | 300000 | total generation deadline in milliseconds |
| `textMediaModel` / `videoModel` |: | text-understanding and video-generation defaults |
| `videoEndpoint` / `videoPollMs` | OpenRouter videos API / 2000 | dedicated video API and polling interval |
| `maxInputBytes` / `maxOutputBytes` / `maxFiles` | 64 MiB / 128 MiB / 8 | aggregate media resource limits |

## Media execution

Audio/image response modalities follow the chosen catalog output, and reserved request/routing fields cannot be replaced through media options. Provider-pin commands await profile edits and preserve other configuration, including disabled media. Generated files use session-scoped filesystem access and unique names. Catalogs retain all advertised outputs, including text from image/audio/video understanding. Dedicated video discovery adds model option limits and pricing SKUs. Job polling and protected content downloads are scoped to the admitted HTTPS origin and job path.

These paths follow [video input documentation](https://openrouter.ai/docs/guides/overview/multimodal/videos) and [video generation/discovery contracts](https://openrouter.ai/docs/guides/overview/multimodal/video-generation). No paid provider inference is exercised by the offline verification suite.

## Upstream selectors

The Plugins-page upstream selector shows per-model endpoint prices, latency, throughput, uptime and available retention evidence. It edits the same draft as the credential and routing controls; Save configuration applies all edits together. The composer selector applies its per-model change immediately. Revision conflicts retain unsaved edits and offer an explicit reload/discard action. Saved preferences for models absent from the latest catalog remain editable.

## Media defaults and options

Media defaults use output-filtered model selectors in the native Plugins form. Catalog pages come from the authenticated host Gateway and share the provider's cached generation catalog. Search and 100-model pagination expose names, IDs, advertised inputs/outputs and prices. Saved selections outside the current page remain intact. Changes apply with the rest of the configuration, and selectors remain available when media generation surfaces are disabled. Catalog loads have a 60-second total deadline and stop when their service generation is disposed.

`mediaModelOptions` saves option defaults by exact model ID, for example `{"vendor/video":{"duration":4,"resolution":"720p"}}`. Tool arguments and `/openrouter-media --options` override individual keys. The merged options are validated against advertised constraints before dispatch. Defaults cannot replace routing, prompts or primary source inputs. Model selectors display advertised parameter keys and allowed values; Defaults accept bounded finite JSON only (32 KiB per model, 512 KiB total). Advertised scalar parameters have typed controls beside each selected model; advanced JSON covers additional provider-specific settings. Invalid drafts block configuration saves.

Explicit command model IDs require the `@` prefix. Quote source paths containing spaces; `--options` accepts one JSON object anywhere among the arguments. Use text output for transcription or captioning when the selected model advertises that transition.

## Protocol restrictions

Dedicated speech and transcription retain their protocol identity separately from chat audio. Speech returns bounded MP3 or PCM bytes; transcription accepts one audio asset and returns text. Video uses an asynchronous job and job-scoped authenticated content downloads. Transcription and video reject incompatible per-request routing/privacy preferences before dispatch; video is not ZDR eligible. Preferences are never weakened automatically. Model-specific parameters and schemas are available through `openrouter_model_info`, configuration controls and generation tools.

## Smart model filters

Optional selector filters limit advertised input/output price per million tokens, minimum context, catalog age and model vendors. Unknown metadata is excluded unless explicitly included. OpenRouter advertises listing time, not original release time. Filters narrow discovery without disabling an already selected hidden model. The chat provider selector appears only for models with multiple advertised upstream tags.
