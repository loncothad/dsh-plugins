import {
  brokerFetch,
  credentialValue,
  editableConfig,
  managedApply,
  optionalString,
} from '@loncothad/dsh-plugin-runtime'
/**
 * fal.ai media provider for dsh: the full fal registry (image, video,
 * audio, 3d — including every transition the models support:
 * text-to-image, image-to-image, image-to-video, video-to-video,
 * audio-to-audio, speech-to-speech…) behind the shared media surfaces:
 * the `fal_generate` tool, the `fal-media-generation` runtime skill,
 * `/fal-models`, and `/fal-media`. Sync runs post to `fal.run`; video and
 * audio ride the queue with polling. dsh has no media-generation seam of
 * its own; this plugin (with `@loncothad/dsh-media-gen`) fills that gap.
 *
 * @module @loncothad/dsh-provider-fal
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { MediaFetch } from '@loncothad/dsh-media-gen'
import {
  modelDefaults,
  registerMediaCatalog,
  registerMediaSurfaces,
} from '@loncothad/dsh-media-gen'
import { FalCatalog } from './catalog.ts'
import { FalGenerator } from './generator.ts'

export * from './catalog.ts'
export * from './generator.ts'
export * from './registry.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'provider-fal'

/** The seams this plugin registers into. */
export const inject = ['tools', 'skills', 'commands']

/** Plugin config. */
export interface Config {
  /** fal.ai key. Falls back to `$FAL_KEY`. */
  apiKey?: string
  credentialSource?: 'stored' | 'broker'
  secretReference?: string
  brokerOrigins?: string[]
  /** Where generated media is written (default `fal-media/`). */
  outDir?: string
  /**
   * Execution path per output modality (`sync` or `queue`); video and
   * audio default to the queue, image and 3d to sync.
   */
  imageExecution?: 'sync' | 'queue'
  videoExecution?: 'sync' | 'queue'
  audioExecution?: 'sync' | 'queue'
  /** Upper bound on a catalog traversal; follows the live advertised page count. */
  registryPages?: number
  /** Default model per output modality when a call names none. */
  imageModel?: string
  videoModel?: string
  audioModel?: string
  meshModel?: string
  meshExecution?: 'sync' | 'queue'
  textModel?: string
  textExecution?: 'sync' | 'queue'
  mediaModelOptions?: Record<string, Record<string, unknown>>
  mediaOutputs?: import('@loncothad/dsh-media-gen').MediaModality[]
  mediaEnabled?: boolean
  mediaTools?: boolean
  mediaSkills?: boolean
  mediaCommands?: boolean
  timeoutMs?: number
  pollMs?: number
  maxInputBytes?: number
  maxOutputBytes?: number
  maxFiles?: number
}

const BaseConfig = z.object({
  credentialSource: z
    .union(['stored', 'broker'])
    .default('stored')
    .description(
      'Broker borrows the scoped credential for each approved HTTPS API request, with no stored-key fallback.',
    ),
  secretReference: z
    .string()
    .description('Secrets Broker reference ID authorized for the fal consumer.'),
  brokerOrigins: z
    .array(z.string())
    .default(['https://api.fal.ai', 'https://fal.run', 'https://queue.fal.run'])
    .description(
      'HTTPS API origins permitted to receive the credential. Download hosts outside this list receive no Authorization header.',
    ),
  apiKey: z.string().role('secret').description('fal API key. Leave blank to inherit $FAL_KEY.'),
  outDir: z
    .string()
    .description('Output directory inside the admitted agent workspace. Default: fal-media.'),
  imageExecution: z
    .union(['sync', 'queue'])
    .default('sync')
    .description('Execution mode for image models.'),
  videoExecution: z
    .union(['sync', 'queue'])
    .default('queue')
    .description('Execution mode for video models.'),
  audioExecution: z
    .union(['sync', 'queue'])
    .default('queue')
    .description('Execution mode for audio models.'),
  registryPages: z
    .number()
    .step(1)
    .min(1)
    .max(10000)
    .default(256)
    .description(
      'Catalog traversal ceiling. Follows the live advertised last page instead of assuming a fixed registry size.',
    ),
  imageModel: z.string().description('Default image model ID from the live fal catalog.'),
  videoModel: z.string().description('Default video model ID.'),
  audioModel: z.string().description('Default audio model ID.'),
  meshModel: z.string().description('Default 3D or mesh model ID.'),
  textModel: z
    .string()
    .description('Default text-output media model, such as transcription or captioning.'),
  textExecution: z
    .union(['sync', 'queue'])
    .default('queue')
    .description('Execution mode for transcription and other text-output media models.'),
  meshExecution: z
    .union(['sync', 'queue'])
    .default('sync')
    .description('Execution mode for 3D and mesh models.'),
  mediaModelOptions: z
    .dict(z.dict(z.any()))
    .description(
      'Saved parameter defaults keyed by exact model ID, for example {"vendor/video": {"duration": 4, "resolution": "720p"}}. Per-call options override individual keys. Advertised constraints are checked before dispatch. Maximum 32 KiB per model and 512 KiB total.',
    ),
  mediaOutputs: z
    .array(z.union(['text', 'image', 'video', 'audio', '3d']))
    .default(['text', 'image', 'video', 'audio', '3d'])
    .description('Enabled media tasks. Disabled outputs are rejected before inference.'),
  mediaEnabled: z
    .boolean()
    .default(true)
    .description(
      'Enable this provider’s media surfaces. Disable to remove tools, skill, and commands.',
    ),
  mediaTools: z.boolean().default(true).description('Expose the model-callable fal_generate tool.'),
  mediaSkills: z
    .boolean()
    .default(true)
    .description('Expose built-in media instructions when the generation tool is enabled.'),
  mediaCommands: z
    .boolean()
    .default(true)
    .description('Expose the human /fal-models and /fal-media commands.'),
  timeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .max(3600000)
    .default(300000)
    .description(
      'Deadline for inference, queue polling, downloads, and publication, in milliseconds.',
    ),
  pollMs: z
    .number()
    .step(1)
    .min(100)
    .max(60000)
    .default(2000)
    .description('Queue polling interval in milliseconds.'),
  maxInputBytes: z
    .number()
    .step(1)
    .min(1)
    .max(1073741824)
    .default(67108864)
    .description('Aggregate local/inline input-byte limit (64 MiB by default).'),
  maxOutputBytes: z
    .number()
    .step(1)
    .min(1)
    .max(1073741824)
    .default(134217728)
    .description('Aggregate downloaded/inline output-byte limit (128 MiB by default).'),
  maxFiles: z
    .number()
    .step(1)
    .min(1)
    .max(64)
    .default(8)
    .description('Maximum output artifacts per generation.'),
})

/** Deterministic hooks for tests. */
export interface FalInternals {
  fetch?: MediaFetch
  now?: () => number
}

/** Register the surfaces with schema-resolved config. */
function activate(ctx: Context, config: Config, internals: FalInternals = {}): void {
  config = { ...config, apiKey: optionalString(config.apiKey) }
  const defaults = modelDefaults(config.mediaModelOptions)
  const reference = () =>
    config.credentialSource === 'broker' ? optionalString(config.secretReference) : undefined
  if (config.credentialSource === 'broker' && !reference())
    throw new Error('Choose a fal broker secret reference')
  const transport = brokerFetch(ctx, {
    consumer: 'fal',
    reference,
    origins: config.brokerOrigins ?? [
      'https://api.fal.ai',
      'https://fal.run',
      'https://queue.fal.run',
    ],
    scheme: 'Key',
    fetch: internals.fetch,
  })
  const apiKey = () =>
    credentialValue(ctx, () =>
      reference() ? 'broker-managed' : (config.apiKey ?? process.env.FAL_KEY),
    )
  const catalog = new FalCatalog({
    apiKey: apiKey,
    ...(internals.fetch !== undefined || reference() ? { fetch: transport } : {}),
    ...(internals.now !== undefined ? { now: internals.now } : {}),
    ...(config.registryPages !== undefined ? { pages: config.registryPages } : {}),
  })
  registerMediaCatalog(
    ctx,
    'falMediaCatalog',
    (signal) => catalog.models(signal),
    (id, signal) => catalog.describe(id, signal),
    (models, signal) => catalog.priceModels(models, signal),
  )
  if (config.mediaEnabled === false) return
  const generator = new FalGenerator({
    apiKey: apiKey,
    fetch: transport,
    now: internals.now,
    timeoutMs: config.timeoutMs,
    maxResponseBytes: Math.min(268435456, 2 * (config.maxOutputBytes ?? 67108864) + 65536),
    pollMs: config.pollMs,
    execution: {
      image: executionOf(config.imageExecution),
      video: executionOf(config.videoExecution),
      audio: executionOf(config.audioExecution),
      '3d': executionOf(config.meshExecution),
      text: executionOf(config.textExecution),
    },
  })
  registerMediaSurfaces(ctx, {
    provider: 'fal',
    label: 'fal.ai',
    outDir: config.outDir ?? 'fal-media',
    models: (signal) => catalog.models(signal),
    describeModel: (id, signal) => catalog.describe(id, signal),
    enabledOutputs: config.mediaOutputs,
    generator,
    fetch: transport,
    toolsEnabled: config.mediaTools,
    skillsEnabled: config.mediaSkills,
    commandsEnabled: config.mediaCommands,
    timeoutMs: config.timeoutMs,
    maxInputBytes: config.maxInputBytes,
    maxOutputBytes: config.maxOutputBytes,
    maxFiles: config.maxFiles,
    defaultOptions: (model) => (Object.hasOwn(defaults, model) ? defaults[model] : undefined),
    defaultModel: (modality) =>
      modality === 'text'
        ? config.textModel
        : modality === 'video'
          ? config.videoModel
          : modality === 'audio'
            ? config.audioModel
            : modality === '3d'
              ? config.meshModel
              : config.imageModel,
  })
}

function executionOf(value: string | undefined): 'sync' | 'queue' | undefined {
  return value === 'sync' || value === 'queue' ? value : undefined
}

/** Complete configuration and managed capability lifetime. */
export const Config = editableConfig(BaseConfig)
export const apply = managedApply(BaseConfig, activate)
