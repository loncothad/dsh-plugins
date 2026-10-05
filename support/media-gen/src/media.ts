/**
 * The media-generation vocabulary: modalities, transitions (what a model
 * accepts as input and what it emits), catalog entries, requests with
 * input assets, and results. Pure domain — no harness imports.
 *
 * A model's transitions are its category: `text-to-image` is inputs
 * `[text]` with output `image`; `image-to-video` is inputs `[image]` with
 * output `video`; `image-to-image` editing is inputs `[text, image]`.
 *
 * @module @loncothad/dsh-media-gen/media
 */

/** Output kinds a media router can generate. */
export type MediaModality = 'text' | 'image' | 'video' | 'audio' | '3d'

/** Input kinds a media model may accept. */
export type MediaInputKind = 'text' | 'image' | 'video' | 'audio' | '3d'
/** Provider execution protocol; an output modality alone does not identify an API. */
export type MediaProtocol = 'chat' | 'video' | 'speech' | 'transcription' | 'fal'
export type MediaSchema = Readonly<Record<string, unknown>>
export interface MediaParameter {
  type: 'string' | 'number' | 'boolean'
  values?: readonly (string | number | boolean)[]
}

/** One media router's catalog entry. */
export interface MediaCatalogModel {
  /** Router model id (the id the generate endpoint accepts). */
  readonly id: string
  /** Human-readable model name. */
  readonly name: string
  /** Optional user-facing description. */
  readonly description?: string
  /** What the model emits. */
  readonly outputs: readonly MediaModality[]
  /** Input modalities the model accepts; `['text']` when undisclosed. */
  readonly inputs?: readonly MediaInputKind[]
  /** Router-disclosed price line (e.g. `$0.15/image`, `$2/M in · $10/M out`). */
  readonly pricing?: string
  /** Free-form router tags (fine-tune, speed, family…). */
  readonly tags?: readonly string[]
  /** Provider-advertised option constraints; undeclared options remain model-specific. */
  readonly parameters?: Readonly<Record<string, MediaParameter>>
  readonly protocol?: MediaProtocol
  readonly inputSchema?: MediaSchema
  readonly outputSchema?: MediaSchema
  readonly fetchedAt?: number
  /** Provider-advertised model creation/release on its platform, in UTC milliseconds. */
  readonly releasedAt?: number
  /** Provider-advertised metadata update, not a model release. */
  readonly updatedAt?: number
  readonly unavailableReason?: string
}

/** Label for a model's transitions, e.g. `text+image -> image`. */
export function transitionsLabel(model: MediaCatalogModel): string {
  const inputs = model.inputs ?? ['text']
  return `${inputs.join('+')} -> ${model.outputs.join('+')}`
}

/** Whether a model accepts one input kind (text is always acceptable via the prompt). */
export function acceptsInput(model: MediaCatalogModel, kind: MediaInputKind): boolean {
  if (kind === 'text') return true
  return model.inputs?.includes(kind) === true
}

/** One input asset: an http(s) or data: URL (local files are inlined before this layer). */
export interface MediaInput {
  readonly kind: Exclude<MediaInputKind, 'text'>
  readonly url: string
  /** Explicit schema path for a named or repeated source asset. */
  readonly path?: readonly (string | number)[]
}

/** One generation request against a router. */
export interface MediaGenerateRequest {
  readonly model: string
  /** The selected catalog output; never guess execution mode from a model ID. */
  readonly output: MediaModality
  readonly protocol?: MediaProtocol
  readonly inputSchema?: MediaSchema
  readonly outputSchema?: MediaSchema
  readonly prompt: string
  /** Source assets for edit/transition scenarios (image-to-image, image-to-video…). */
  readonly inputs?: readonly MediaInput[]
  /** Router-specific request options merged over the body defaults. */
  readonly options?: Readonly<Record<string, unknown>>
}

/** One generated file written to disk. */
export interface MediaGeneratedFile {
  readonly path: string
  readonly mime: string
  readonly modality: MediaModality
}

/** One generation outcome. */
export interface MediaGenerateResult {
  readonly files: readonly MediaGeneratedFile[]
  /** Companion text (captions, revised prompts) when the router returns it. */
  readonly text?: string
  /** The raw router response, for diagnostics. */
  readonly rollback?: () => Promise<void>
  readonly raw: unknown
  /** Provider-normalized artifacts, used when generic response harvesting cannot identify protected URLs. */
  readonly artifacts?: readonly { url: string; mime: string; modality: MediaModality }[]
  /** A result-owned capability for this job's protected artifacts; never serialized into a tool value. */
  readonly loadArtifact?: (
    url: string,
    maxBytes: number,
    signal: AbortSignal,
  ) => Promise<Uint8Array>
}

/** Performs generations for one router. */
export interface MediaGenerator {
  generate(request: MediaGenerateRequest, signal?: AbortSignal): Promise<MediaGenerateResult>
}

/** File surface generators write through; injected in tests. */
export interface MediaIo {
  mkdir(path: string): Promise<void>
  /** Returns an ownership capability for undoing only this publication. */
  write(path: string, bytes: Uint8Array): Promise<MediaPublication>
  /** Reads one local input file as a data: URL. */
  readDataUrl?(path: string): Promise<string>
}
export interface MediaPublication {
  rollback(): Promise<void>
}

/** HTTP transport injection point. */
export type MediaFetch = typeof fetch

/** Filename metadata shared by input inlining and output normalization. */
const MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'model/obj',
  usdz: 'model/vnd.usdz+zip',
  stl: 'model/stl',
  ply: 'model/ply',
}
export function mimeOfPath(path: string): string | undefined {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  const extension = dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
  return Object.hasOwn(MIMES, extension) ? MIMES[extension] : undefined
}
export function mimeOfUrl(value: string): string | undefined {
  try {
    return mimeOfPath(new URL(value).pathname)
  } catch {
    return undefined
  }
}

/** Classify a MIME type (or data: URL prefix) into a modality. */
export function modalityOfMime(mime: string): MediaModality | undefined {
  const value = mime.toLowerCase()
  if (value.startsWith('image/')) return 'image'
  if (value.startsWith('video/')) return 'video'
  if (value.startsWith('audio/')) return 'audio'
  if (value.startsWith('model/') || value.includes('model3d')) return '3d'
  return undefined
}

/** Classify a URL by its extension into a modality. */
export function modalityOfUrl(url: string): MediaModality | undefined {
  if (url.startsWith('data:'))
    return modalityOfMime(
      url.slice(
        5,
        url.indexOf(';') > 0
          ? url.indexOf(';')
          : url.indexOf(',') > 0
            ? url.indexOf(',')
            : url.length,
      ),
    )
  const mime = mimeOfUrl(url)
  return mime ? modalityOfMime(mime) : undefined
}
