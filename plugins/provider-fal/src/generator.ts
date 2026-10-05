import { getPiUserAgent } from '@loncothad/dsh-plugin-runtime'

/**
 * The fal.ai generator: one POST against `https://fal.run/{model}` (sync)
 * or the queue at `https://queue.fal.run/{model}` (submit, poll
 * `status_url`, collect `response_url`). Input assets map onto the body
 * field fal schemas use per modality (`image_url`/`image_urls`,
 * `video_url`, `audio_url`), overridable per request through `options`.
 * Errors classify onto the shared media codes.
 *
 * @module @loncothad/dsh-provider-fal/generator
 */

import type {
  MediaFetch,
  MediaGenerateRequest,
  MediaGenerateResult,
  MediaGenerator,
  MediaModality,
} from '@loncothad/dsh-media-gen'
import {
  assignMediaAsset,
  MediaExecutionError,
  mediaProperties,
  readMediaResponse,
  validateMediaBody,
} from '@loncothad/dsh-media-gen'

/** The sync inference host. */
export const FAL_RUN_HOST = 'https://fal.run'

/** The queue inference host (recommended for video and long runs). */
export const FAL_QUEUE_HOST = 'https://queue.fal.run'

const USER_AGENT = getPiUserAgent()

/** Generator options; everything except the key resolvers is injectable. */
export interface FalGeneratorOptions {
  readonly apiKey: () => string | undefined
  /** Sync host override. */
  readonly runHost?: string
  /** Queue host override. */
  readonly queueHost?: string
  /**
   * Execution path per output modality: `sync` posts to fal.run, `queue`
   * submits to the queue and polls. Default: `image`/`3d` sync,
   * `video`/`audio` queue.
   */
  readonly execution?: Partial<Record<MediaModality, 'sync' | 'queue'>>
  /** Queue poll interval (default 2s) and overall deadline (default 5min). */
  readonly pollMs?: number
  readonly maxResponseBytes?: number
  readonly timeoutMs?: number
  /** Test injections: transport, clock, and sleeper. */
  readonly fetch?: MediaFetch
  readonly now?: () => number
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

type FalRawItem = Record<string, unknown>

/** The fal-backed media generator. */
export class FalGenerator implements MediaGenerator {
  constructor(private readonly options: FalGeneratorOptions) {}

  async generate(
    request: MediaGenerateRequest,
    signal?: AbortSignal,
  ): Promise<MediaGenerateResult> {
    const deadline = AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 300_000),
    ])
    deadline.throwIfAborted()
    const key = this.options.apiKey()
    if (key === undefined || key.length === 0) {
      throw new MediaExecutionError('the fal.ai key is not set', 'AUTH')
    }
    const modality = request.output
    const mode =
      this.options.execution?.[modality] ??
      (modality === 'video' || modality === 'audio' ? 'queue' : 'sync')
    const body = buildFalBody(request)
    if (request.inputSchema) {
      try {
        validateMediaBody(request.inputSchema, body)
      } catch (error) {
        throw new MediaExecutionError(
          error instanceof Error ? error.message : 'Invalid fal model input',
          'INPUT',
        )
      }
    }
    const raw =
      mode === 'queue'
        ? await this.runQueued(key, request.model, body, deadline)
        : await this.runSync(key, request.model, body, deadline)
    if (request.outputSchema) {
      try {
        validateMediaBody(request.outputSchema, raw)
      } catch {
        throw new MediaExecutionError(
          'fal returned output outside this model’s advertised schema',
          'NO_OUTPUT',
        )
      }
    }
    const plain = extractText(raw)
    const text =
      request.output === 'text' && raw && typeof raw === 'object' && Object.keys(raw).length > 1
        ? JSON.stringify(raw, null, 2)
        : plain
    return {
      files: [],
      ...(typeof text === 'string' ? { text } : {}),
      raw,
    }
  }

  /** One synchronous fal.run call. */
  private async runSync(
    key: string,
    model: string,
    body: FalRawItem,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.transport(
      `${this.options.runHost ?? FAL_RUN_HOST}/${model}`,
      key,
      body,
      signal,
    )
    return response as unknown
  }

  /** Submit to the queue, poll status_url, then collect response_url. */
  private async runQueued(
    key: string,
    model: string,
    body: FalRawItem,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const submitted = (await this.transport(
      `${this.options.queueHost ?? FAL_QUEUE_HOST}/${model}`,
      key,
      body,
      signal,
    )) as FalRawItem
    const statusUrl = typeof submitted.status_url === 'string' ? submitted.status_url : undefined
    const responseUrl =
      typeof submitted.response_url === 'string' ? submitted.response_url : undefined
    if (statusUrl === undefined || responseUrl === undefined) {
      throw new MediaExecutionError(
        'the fal queue accepted the request but omitted its status/response URLs',
        'NO_OUTPUT',
      )
    }
    const identity = submitted.request_id
    if (typeof identity !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(identity))
      throw new MediaExecutionError(
        'fal did not return a valid queue request identity',
        'NO_OUTPUT',
      )
    const checkedStatus = queueUrl(
      statusUrl,
      this.options.queueHost ?? FAL_QUEUE_HOST,
      identity,
      'status',
    )
    const checkedResponse = queueUrl(
      responseUrl,
      this.options.queueHost ?? FAL_QUEUE_HOST,
      identity,
      '',
    )
    const cancelUrl =
      typeof submitted.cancel_url === 'string'
        ? queueUrl(
            submitted.cancel_url,
            this.options.queueHost ?? FAL_QUEUE_HOST,
            identity,
            'cancel',
          )
        : undefined
    try {
      const deadline = (this.options.now?.() ?? Date.now()) + (this.options.timeoutMs ?? 300_000)
      for (;;) {
        signal?.throwIfAborted()
        const status = (await this.get(key, checkedStatus, signal)) as FalRawItem
        const state = typeof status.status === 'string' ? status.status.toUpperCase() : undefined
        if (state === 'COMPLETED') break
        if (state === 'FAILED' || state === 'ERROR') {
          throw new MediaExecutionError(`the fal queue reported ${state}`, 'SERVER')
        }
        if ((this.options.now?.() ?? Date.now()) > deadline) {
          throw new MediaExecutionError(
            'the fal queue did not complete within the deadline',
            'TRANSPORT',
          )
        }
        await (this.options.sleep ?? defaultSleep)(this.options.pollMs ?? 2_000, signal)
      }
      return (await this.get(key, checkedResponse, signal)) as unknown
    } catch (error) {
      if (signal?.aborted && cancelUrl) {
        try {
          await (this.options.fetch ?? fetch)(cancelUrl, {
            method: 'PUT',
            redirect: 'error',
            headers: { authorization: `Key ${key}` },
            signal: AbortSignal.timeout(5000),
          })
        } catch (_cancelError) {
          /* Preserve the original cancellation when the provider cannot acknowledge cleanup. */
        }
      }
      throw error
    }
  }

  /** One authenticated JSON POST, classifying failures. */
  private async transport(
    url: string,
    key: string,
    body: FalRawItem,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await (this.options.fetch ?? fetch)(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Key ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    })
    if (response.status === 401 || response.status === 403) {
      throw new MediaExecutionError(
        `fal.ai rejected the key (HTTP ${response.status})`,
        'AUTH',
        response.status,
      )
    }
    if (response.status === 404) {
      throw new MediaExecutionError(
        `fal.ai has no model at ${new URL(url).pathname.slice(1)}`,
        'NOT_FOUND',
        404,
      )
    }
    if (response.status === 422) {
      throw new MediaExecutionError(
        'fal.ai rejected the request body (HTTP 422); check this model’s input fields and options',
        'CLIENT',
        422,
      )
    }
    if (!response.ok) {
      throw new MediaExecutionError(
        `the fal.ai request failed (HTTP ${response.status})`,
        response.status >= 500 ? 'SERVER' : 'CLIENT',
        response.status,
      )
    }
    return this.json(response, signal)
  }

  /** One authenticated GET (status polling, response collection). */
  private async get(key: string, url: string, signal?: AbortSignal): Promise<unknown> {
    const response = await (this.options.fetch ?? fetch)(url, {
      redirect: 'error',
      headers: {
        authorization: `Key ${key}`,
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      ...(signal !== undefined ? { signal } : {}),
    })
    if (!response.ok) {
      throw new MediaExecutionError(
        `a fal.ai queue request failed (HTTP ${response.status})`,
        response.status >= 500 ? 'SERVER' : 'CLIENT',
        response.status,
      )
    }
    return this.json(response, signal)
  }
  private async json(response: Response, signal?: AbortSignal): Promise<unknown> {
    const bytes = await readMediaResponse(
      response,
      this.options.maxResponseBytes ?? 16777216,
      signal ?? AbortSignal.timeout(15000),
    )
    try {
      return JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new MediaExecutionError('fal returned invalid JSON', 'NO_OUTPUT')
    }
  }
}

/**
 * Build the fal request body: prompt under `prompt`, input assets under
 * the schema's conventional fields, then the caller's options merged on
 * top (so per-model field names always win).
 */
export function buildFalBody(request: Omit<MediaGenerateRequest, 'output'>): FalRawItem {
  const schema = request.inputSchema
  const properties = schema ? mediaProperties(schema) : undefined
  const body: FalRawItem = structuredClone(request.options ?? {})
  if (request.prompt.trim()) {
    const field = properties
      ? ['prompt', 'text', 'input'].find((key) => Object.hasOwn(properties, key))
      : 'prompt'
    if (!field)
      throw new MediaExecutionError(
        'This model has no prompt field. Supply its required inputs through options and assets.',
        'INPUT',
      )
    if (Object.hasOwn(body, field))
      throw new MediaExecutionError('Options cannot overwrite the explicit prompt', 'INPUT')
    body[field] = request.prompt
  }
  for (const input of request.inputs ?? [])
    if (input.path) assignMediaAsset(body, input.path, input.url)
  for (const kind of ['image', 'video', 'audio', '3d'] as const) {
    const urls =
      request.inputs
        ?.filter((input) => input.kind === kind && !input.path)
        .map((input) => input.url) ?? []
    if (!urls.length) continue
    const singular = kind === '3d' ? 'model_url' : `${kind}_url`,
      plural = `${kind}_urls`
    const field = properties
      ? urls.length === 1 && Object.hasOwn(properties, singular)
        ? singular
        : Object.hasOwn(properties, plural)
          ? plural
          : undefined
      : urls.length === 1
        ? singular
        : plural
    if (!field)
      throw new MediaExecutionError(
        `Specify the schema path for this model's ${kind} assets`,
        'INPUT',
      )
    if (Object.hasOwn(body, field))
      throw new MediaExecutionError('Source assets cannot overwrite model options', 'INPUT')
    body[field] = field === singular ? urls[0] : urls
  }
  return body
}

/** Companion text keys fal models commonly return. */
function extractText(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  for (const key of [
    'text',
    'output',
    'transcription',
    'caption',
    'description',
    'revised_prompt',
  ]) {
    const value = (raw as FalRawItem)[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

/** Never forward the provider key to response-selected origins, credentials, or redirect targets. */
function queueUrl(value: string, host: string, id: string, action: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new MediaExecutionError('The fal queue returned an invalid callback URL', 'NO_OUTPUT')
  }
  const origin = new URL(host)
  if (
    url.protocol !== 'https:' ||
    url.origin !== origin.origin ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new MediaExecutionError(
      'The fal queue returned a callback outside its configured origin',
      'NO_OUTPUT',
    )
  if (!url.pathname.endsWith(`/requests/${id}${action ? `/${action}` : ''}`) || url.search)
    throw new MediaExecutionError(
      'The fal queue returned a callback outside its accepted request scope',
      'NO_OUTPUT',
    )
  return url.href
}
