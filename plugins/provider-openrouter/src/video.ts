/** OpenRouter's separate asynchronous video API, with job-scoped authenticated downloads. */

import type {
  MediaFetch,
  MediaGenerateRequest,
  MediaGenerateResult,
} from '@loncothad/dsh-media-gen'
import {
  assignMediaAsset,
  MediaExecutionError,
  readMediaResponse,
  validateMediaBody,
} from '@loncothad/dsh-media-gen'

export interface VideoOptions {
  endpoint: string
  apiKey: string
  headers?: Readonly<Record<string, string>>
  fetch?: MediaFetch
  pollMs?: number
  body?: Record<string, unknown>
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MediaExecutionError('Invalid video job response', 'NO_OUTPUT')
  return value as Record<string, unknown>
}
export async function generateVideo(
  options: VideoOptions,
  request: MediaGenerateRequest,
  signal: AbortSignal,
): Promise<MediaGenerateResult> {
  const endpoint = new URL(options.endpoint)
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new MediaExecutionError(
      'Video generation requires a credential-free HTTPS endpoint',
      'INPUT',
    )
  const headers = {
    ...options.headers,
    authorization: `Bearer ${options.apiKey}`,
    accept: 'application/json',
  }
  const fetchImpl = options.fetch ?? fetch
  const json = async (url: string, body?: Record<string, unknown>) => {
    signal.throwIfAborted()
    const response = await fetchImpl(url, {
      method: body ? 'POST' : 'GET',
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal,
    })
    if (!response.ok)
      throw new MediaExecutionError(
        `OpenRouter video request failed (HTTP ${response.status})`,
        response.status === 401 || response.status === 403
          ? 'AUTH'
          : response.status >= 500
            ? 'SERVER'
            : 'CLIENT',
        response.status,
      )
    const bytes = await readMediaResponse(response, 2097152, signal)
    try {
      return object(JSON.parse(new TextDecoder().decode(bytes)))
    } catch {
      throw new MediaExecutionError('Video job returned invalid JSON', 'NO_OUTPUT')
    }
  }
  if (
    Object.keys(request.options ?? {}).some((key) =>
      ['model', 'prompt', 'provider', 'callback_url', 'stream'].includes(key),
    )
  )
    throw new MediaExecutionError(
      'Video options cannot override the selected route, prompt, or callback destination',
      'INPUT',
    )
  if (Object.keys(options.body ?? {}).length)
    throw new MediaExecutionError(
      'OpenRouter video cannot enforce per-request provider pins or privacy routing; ZDR is unsupported. Change the incompatible preference explicitly before dispatch.',
      'INPUT',
    )
  const { provider_options, ...parameters } = request.options ?? {}
  const body: Record<string, unknown> = {
    ...structuredClone(parameters),
    model: request.model,
    prompt: request.prompt,
  }
  for (const asset of request.inputs ?? []) {
    if (asset.kind !== 'image')
      throw new MediaExecutionError('OpenRouter video accepts image references only', 'INPUT')
    if (asset.path) assignMediaAsset(body, asset.path, asset.url)
  }
  const references = (request.inputs ?? [])
    .filter((input) => !input.path)
    .map((input) => ({ type: `${input.kind}_url`, [`${input.kind}_url`]: { url: input.url } }))
  if (references.length) {
    if (body.frame_images || body.input_references)
      throw new MediaExecutionError(
        'Address reference assets by schema path when explicit frame or reference arrays are supplied',
        'INPUT',
      )
    body.input_references = references
  }
  if (request.inputSchema)
    validateMediaBody(request.inputSchema, {
      ...body,
      ...(provider_options ? { provider_options } : {}),
    })
  if (provider_options) body.provider = { options: provider_options }
  const submitted = await json(endpoint.href, body)
  if (
    typeof submitted.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,256}$/.test(submitted.id) ||
    typeof submitted.polling_url !== 'string'
  )
    throw new MediaExecutionError(
      'The video submit response has no valid job identity',
      'NO_OUTPUT',
    )
  const jobPath = `${endpoint.pathname.replace(/\/$/, '')}/${submitted.id}`
  const checked = (value: string, content = false) => {
    const url = new URL(value)
    if (
      url.origin !== endpoint.origin ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== (content ? `${jobPath}/content` : jobPath) ||
      (!content && url.search) ||
      (content && [...url.searchParams.keys()].some((key) => key !== 'index')) ||
      (content && !/^\d{1,2}$/.test(url.searchParams.get('index') ?? '0'))
    )
      throw new MediaExecutionError('Video job URL is outside its admitted job scope', 'NO_OUTPUT')
    return url.href
  }
  const poll = checked(submitted.polling_url)
  let completed = submitted
  try {
    for (;;) {
      signal.throwIfAborted()
      if (completed.status === 'completed') break
      if (['failed', 'cancelled', 'expired'].includes(String(completed.status)))
        throw new MediaExecutionError(
          `Video job ${submitted.id} ended with status ${completed.status}`,
          'SERVER',
        )
      if (completed.status !== 'pending' && completed.status !== 'in_progress')
        throw new MediaExecutionError('Unknown video job status', 'NO_OUTPUT')
      await sleep(options.pollMs ?? 30000, signal)
      completed = await json(poll)
    }
  } catch (error) {
    if (signal.aborted)
      throw new MediaExecutionError(
        `Stopped waiting for video job ${submitted.id}. The remote job may still complete and incur charges; inspect its status before submitting another generation.`,
        'TRANSPORT',
      )
    throw error
  }
  if (
    !Array.isArray(completed.unsigned_urls) ||
    !completed.unsigned_urls.length ||
    completed.unsigned_urls.length > 64 ||
    completed.unsigned_urls.some((url) => typeof url !== 'string')
  )
    throw new MediaExecutionError(
      'The completed video job has no bounded content list',
      'NO_OUTPUT',
    )
  const urls = [...new Set((completed.unsigned_urls as string[]).map((url) => checked(url, true)))]
  return {
    files: [],
    raw: completed,
    artifacts: urls.map((url) => ({ url, mime: 'video/mp4', modality: 'video' })),
    loadArtifact: async (url, maxBytes, downloadSignal) => {
      if (!urls.includes(url))
        throw new MediaExecutionError('The artifact does not belong to this video job', 'INPUT')
      downloadSignal.throwIfAborted()
      const response = await fetchImpl(checked(url, true), {
        headers,
        redirect: 'error',
        signal: downloadSignal,
      })
      if (!response.ok)
        throw new MediaExecutionError(
          `Video content download failed (HTTP ${response.status})`,
          'SERVER',
          response.status,
        )
      return readMediaResponse(response, maxBytes, downloadSignal)
    },
  }
}
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      cleanup()
      reject(signal.reason)
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
