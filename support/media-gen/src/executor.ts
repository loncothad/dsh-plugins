/**
 * The shared generation executor: run one router generator, harvest the
 * response, download inline or remote artifacts, and write them under the
 * output directory. Input assets referenced by local path are inlined as
 * data: URLs first, so edit/transition scenarios (image-to-image,
 * image-to-video…) reach the router uniformly.
 *
 * @module @loncothad/dsh-media-gen/executor
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { HarvestedArtifact } from './harvest.ts'
import { harvestMedia } from './harvest.ts'
import type {
  MediaFetch,
  MediaGeneratedFile,
  MediaGenerateRequest,
  MediaGenerateResult,
  MediaGenerator,
  MediaInput,
  MediaIo,
  MediaPublication,
} from './media.ts'
import { mimeOfPath } from './media.ts'
import { publicArtifactFetch, publicArtifactUrl } from './network.ts'
import { publishMediaFile } from './publication.ts'

/** Default file surface over node:fs. */
export const defaultMediaIo: MediaIo = {
  async mkdir(path) {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(path, { recursive: true })
  },
  async write(path, bytes) {
    return publishMediaFile(path, bytes)
  },
  async readDataUrl(path) {
    const { readFile } = await import('node:fs/promises')
    const bytes = await readFile(path)
    return `data:${mediaMime(path)};base64,${Buffer.from(bytes).toString('base64')}`
  },
}

/** Executor options. */
export interface MediaExecutorOptions {
  /** Directory generated files are written under. */
  readonly outDir: string
  /** Performs generations against the router. */
  readonly generator: MediaGenerator
  /** File surface override for tests. */
  readonly io?: MediaIo
  /** HTTP transport override for artifact downloads. */
  readonly fetch?: MediaFetch
  /** File-name stem for outputs (default `media`). */
  readonly stem?: string
  readonly timeoutMs?: number
  readonly maxInputBytes?: number
  readonly maxOutputBytes?: number
  readonly maxFiles?: number
}

/** One execution failure, classified for surfaces. */
export class MediaExecutionError extends Error {
  constructor(
    message: string,
    readonly code: 'AUTH' | 'NOT_FOUND' | 'NO_OUTPUT' | 'INPUT' | 'TRANSPORT' | 'SERVER' | 'CLIENT',
    readonly status?: number,
  ) {
    super(message)
  }
}

/**
 * Run one generation and persist its artifacts. Local input paths are
 * inlined before the call; remote artifacts are downloaded; data: URLs
 * are decoded in place.
 */
export async function runMediaGeneration(
  options: MediaExecutorOptions,
  request: MediaGenerateRequest,
  signal?: AbortSignal,
): Promise<MediaGenerateResult> {
  const io = options.io ?? defaultMediaIo
  const fetchImpl = options.fetch ?? publicArtifactFetch
  const timeoutMs = options.timeoutMs ?? 300_000
  const maxInputBytes = options.maxInputBytes ?? 64 * 1024 * 1024
  const maxOutputBytes = options.maxOutputBytes ?? 128 * 1024 * 1024
  const maxFiles = options.maxFiles ?? 8
  for (const amount of [timeoutMs, maxInputBytes, maxOutputBytes, maxFiles])
    if (!Number.isSafeInteger(amount) || amount < 1)
      throw new MediaExecutionError('Invalid media execution limits', 'INPUT')
  const deadline = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(timeoutMs),
  ])
  deadline.throwIfAborted()
  if (
    !['text', 'image', 'audio', 'video', '3d'].includes(request.output) ||
    (!request.prompt.trim() && !request.inputs?.length) ||
    request.prompt.length > 64 * 1024 ||
    !request.model ||
    request.model.length > 512 ||
    (request.inputs?.length ?? 0) > 8
  )
    throw new MediaExecutionError('Invalid or oversized media request', 'INPUT')
  const inputs = await inlineInputs(io, request.inputs, maxInputBytes, deadline)

  const raw = await options.generator.generate({ ...request, inputs }, deadline)
  deadline.throwIfAborted()
  if (request.output === 'text') {
    if (!raw.text?.trim())
      throw new MediaExecutionError('The model returned no text output', 'NO_OUTPUT')
    if (Buffer.byteLength(raw.text, 'utf8') > maxOutputBytes)
      throw new MediaExecutionError('Text output exceeds its output-byte limit', 'NO_OUTPUT')
    return { ...raw, files: [] }
  }
  const artifacts = raw.artifacts ?? harvestMedia(raw.raw, request.output, request.outputSchema)
  if (artifacts.length === 0) {
    throw new MediaExecutionError(
      `the model returned no generated media (response keys: ${JSON.stringify(topKeys(raw.raw))})`,
      'NO_OUTPUT',
    )
  }
  if (artifacts.length > maxFiles)
    throw new MediaExecutionError(
      'The generated media exceeds the configured file-count limit',
      'NO_OUTPUT',
    )

  const stem = options.stem ?? 'media'
  if (!/^[a-z0-9_-]+$/i.test(stem))
    throw new MediaExecutionError('Invalid output filename stem', 'INPUT')
  const slug =
    request.model
      .replace(/[^a-z0-9.-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'model'
  const generation = randomUUID()
  await io.mkdir(options.outDir)
  const files: MediaGeneratedFile[] = []
  let remaining = maxOutputBytes
  const downloaded: { artifact: HarvestedArtifact; bytes: Uint8Array }[] = []
  for (const artifact of artifacts) {
    deadline.throwIfAborted()
    const bytes =
      raw.loadArtifact && artifact.url
        ? await raw.loadArtifact(artifact.url, remaining, deadline)
        : await artifactBytes(artifact, fetchImpl, remaining, deadline)
    if (!bytes.byteLength || bytes.byteLength > remaining)
      throw new MediaExecutionError('Generated media exceeds its output-byte limit', 'NO_OUTPUT')
    deadline.throwIfAborted()
    remaining -= bytes.byteLength
    downloaded.push({ artifact, bytes })
  }
  // Validate the complete bounded batch before publishing the first artifact.
  const published: { path: string; receipt: MediaPublication }[] = []
  try {
    for (const [index, { artifact, bytes }] of downloaded.entries()) {
      deadline.throwIfAborted()
      const extension = extensionOf(artifact.mime)
      const path = join(
        options.outDir,
        `${stem}-${slug}-${generation}-${String(index + 1).padStart(2, '0')}${extension}`,
      )
      const receipt = await io.write(path, bytes)
      published.push({ path, receipt })
      deadline.throwIfAborted()
      files.push({ path, mime: artifact.mime, modality: artifact.modality })
    }
  } catch (error) {
    const failed: string[] = []
    for (const file of [...published].reverse()) {
      try {
        await file.receipt.rollback()
      } catch {
        failed.push(file.path)
      }
    }
    if (failed.length)
      throw new MediaExecutionError(
        `Media publication failed; these files could not be rolled back safely: ${failed.join(', ')}`,
        'CLIENT',
      )
    throw error
  }
  return {
    files,
    ...(raw.text !== undefined ? { text: raw.text } : {}),
    raw: raw.raw,
    rollback: async () => {
      const failed: string[] = []
      for (const file of [...published].reverse())
        try {
          await file.receipt.rollback()
        } catch {
          failed.push(file.path)
        }
      if (failed.length)
        throw new MediaExecutionError(
          'Generated files changed before rollback; cleanup refused',
          'CLIENT',
        )
    },
  }
}

/** Inline local input paths as data: URLs; pass URLs through untouched. */
async function inlineInputs(
  io: MediaIo,
  inputs: readonly MediaInput[] | undefined,
  limit: number,
  signal: AbortSignal,
): Promise<readonly MediaInput[] | undefined> {
  if (inputs === undefined || inputs.length === 0) return inputs
  const resolved: MediaInput[] = []
  let bytes = 0
  for (const input of inputs) {
    signal.throwIfAborted()
    if (
      !input.url.startsWith('http://') &&
      !input.url.startsWith('https://') &&
      !input.url.startsWith('data:')
    ) {
      if (io.readDataUrl === undefined) {
        throw new MediaExecutionError(
          `cannot read the local ${input.kind} input ${input.url}`,
          'INPUT',
        )
      }
      const url = await io.readDataUrl(input.url)
      bytes += dataUrlBytes(url)
      if (bytes > limit)
        throw new MediaExecutionError('The media inputs exceed their aggregate byte limit', 'INPUT')
      resolved.push({ ...input, url })
      continue
    }
    if (input.url.startsWith('data:')) {
      bytes += dataUrlBytes(input.url)
      if (bytes > limit)
        throw new MediaExecutionError('The media inputs exceed their aggregate byte limit', 'INPUT')
    }
    resolved.push(input)
  }
  return resolved
}

/** Fetch bytes for one artifact, from its URL or inline base64. */
async function artifactBytes(
  artifact: HarvestedArtifact,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (artifact.base64 !== undefined) {
    if (Math.floor((artifact.base64.length * 3) / 4) - 2 > limit)
      throw new MediaExecutionError('Generated media exceeds its output-byte limit', 'NO_OUTPUT')
    const bytes = new Uint8Array(Buffer.from(artifact.base64, 'base64'))
    if (!bytes.byteLength || bytes.byteLength > limit)
      throw new MediaExecutionError(
        'Generated media is empty or exceeds its output-byte limit',
        'NO_OUTPUT',
      )
    return bytes
  }
  if (artifact.url === undefined)
    throw new MediaExecutionError('an artifact carried neither URL nor payload', 'NO_OUTPUT')
  const url = publicArtifactUrl(artifact.url)
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new MediaExecutionError(
      'Generated artifact downloads require credential-free HTTPS URLs',
      'NO_OUTPUT',
    )
  const response = await fetchImpl(url.href, { redirect: 'error', credentials: 'omit', signal })
  if (!response.ok) {
    throw new MediaExecutionError(
      `downloading the generated media failed (HTTP ${response.status})`,
      'SERVER',
      response.status,
    )
  }
  return readMediaResponse(response, limit, signal)
}

/** Bounded response collection shared by public and provider-authenticated artifact paths. */
export async function readMediaResponse(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body)
    throw new MediaExecutionError('Generated artifact has no response body', 'NO_OUTPUT')
  const reader = response.body.getReader()
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > limit)
        throw new MediaExecutionError('Generated media exceeds its output-byte limit', 'NO_OUTPUT')
      chunks.push(chunk.value)
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  signal.throwIfAborted()
  if (!length) throw new MediaExecutionError('Generated artifact is empty', 'NO_OUTPUT')
  return new Uint8Array(Buffer.concat(chunks, length))
}

function dataUrlBytes(url: string): number {
  const match = /^data:[^;,]+;base64,([a-z0-9+/]*={0,2})$/i.exec(url)
  if (!match || match[1]!.length % 4 !== 0)
    throw new MediaExecutionError('Media inputs require a valid base64 data URL', 'INPUT')
  return (
    (match[1]!.length * 3) / 4 - (match[1]!.endsWith('==') ? 2 : match[1]!.endsWith('=') ? 1 : 0)
  )
}
export function mediaMime(path: string): string {
  return mimeOfPath(path) ?? 'application/octet-stream'
}

function extensionOf(mime: string): string {
  const known: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg',
    'model/gltf-binary': '.glb',
    'model/gltf+json': '.gltf',
    'model/obj': '.obj',
    'model/stl': '.stl',
    'model/ply': '.ply',
    'model/vnd.usdz+zip': '.usdz',
    'video/quicktime': '.mov',
    'audio/flac': '.flac',
    'audio/mp4': '.m4a',
    'application/octet-stream': '.bin',
  }
  return known[mime.toLowerCase()] ?? `.${mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin'}`
}

function topKeys(raw: unknown): string[] {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? Object.keys(raw).slice(0, 8)
    : []
}
