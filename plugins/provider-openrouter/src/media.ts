/**
 * OpenRouter's media generation: image-output and audio-output models
 * ride the chat-completions wire with `modalities` — inputs arrive as
 * multimodal content parts (images as `image_url`, audio as
 * `input_audio`), so image-to-image editing and image/video reference
 * scenarios work wherever the model accepts them. Non-streaming.
 *
 * @module @loncothad/dsh-provider-openrouter/media
 */

import type {
  MediaFetch,
  MediaGenerateRequest,
  MediaGenerateResult,
  MediaGenerator,
} from '@loncothad/dsh-media-gen'
import { MediaExecutionError, readMediaResponse } from '@loncothad/dsh-media-gen'
import { generateAudio } from './audio.ts'
import { generateVideo } from './video.ts'

/** Generator options. */
export interface OpenRouterMediaOptions {
  readonly apiKey: () => string | undefined
  /** Chat-completions endpoint (full URL). */
  readonly endpoint: string
  readonly videoEndpoint?: string
  readonly videoPollMs?: number
  readonly speechEndpoint?: string
  readonly transcriptionEndpoint?: string
  readonly maxResponseBytes?: number
  /** Attribution headers OpenRouter requests. */
  readonly headers?: Readonly<Record<string, string>>
  /** Voice for speech/audio-output models, when supported. */
  readonly audioVoice?: () => string | undefined
  /** Audio container requested from audio-output models (default `wav`). */
  readonly audioFormat?: () => string | undefined
  /** Extra body fields merged last (the pinned-provider routing preference). */
  readonly extraBody?: (request: MediaGenerateRequest) => Record<string, unknown> | undefined
  /** Test injection: transport. */
  readonly fetch?: MediaFetch
}

type ContentPart = Record<string, unknown>

/** The OpenRouter-backed media generator. */
export class OpenRouterMediaGenerator implements MediaGenerator {
  constructor(private readonly options: OpenRouterMediaOptions) {}

  async generate(
    request: MediaGenerateRequest,
    signal?: AbortSignal,
  ): Promise<MediaGenerateResult> {
    const key = this.options.apiKey()
    if (key === undefined || key.length === 0) {
      throw new MediaExecutionError('the OpenRouter key is not set', 'AUTH')
    }
    if (request.protocol === 'speech' || request.protocol === 'transcription') {
      const base = this.options.endpoint.replace(/\/chat\/completions\/?$/, '')
      return generateAudio(
        {
          endpoint:
            request.protocol === 'speech'
              ? (this.options.speechEndpoint ?? `${base}/audio/speech`)
              : (this.options.transcriptionEndpoint ?? `${base}/audio/transcriptions`),
          apiKey: key,
          fetch: this.options.fetch,
          headers: this.options.headers,
          voice: this.options.audioVoice?.(),
          routing: this.options.extraBody?.(request),
          maxBytes: this.options.maxResponseBytes ?? 134217728,
        },
        request,
        signal ?? AbortSignal.timeout(300000),
      )
    }
    if (request.output === 'video') {
      if (!this.options.videoEndpoint)
        throw new MediaExecutionError(
          'Configure the OpenRouter video endpoint before video generation',
          'INPUT',
        )
      return generateVideo(
        {
          endpoint: this.options.videoEndpoint,
          apiKey: key,
          fetch: this.options.fetch,
          headers: this.options.headers,
          pollMs: this.options.videoPollMs,
          body: this.options.extraBody?.(request),
        },
        request,
        signal ?? AbortSignal.timeout(300000),
      )
    }
    if (!['text', 'image', 'audio'].includes(request.output))
      throw new MediaExecutionError(
        'This OpenRouter chat adapter requires text, image, or audio output',
        'INPUT',
      )
    if (
      Object.keys(request.options ?? {}).some((key) =>
        ['model', 'messages', 'modalities', 'stream', 'provider'].includes(key),
      )
    )
      throw new MediaExecutionError(
        'Media options cannot override the selected model, output, messages, or provider routing',
        'INPUT',
      )
    const modalities = request.output === 'text' ? ['text'] : ['text', request.output]
    const body: Record<string, unknown> = {
      model: request.model,
      messages: [
        {
          role: 'user',
          content: buildContent(request),
        },
      ],
      modalities,
      stream: false,
      ...(modalities.includes('audio')
        ? {
            audio: {
              ...(this.options.audioVoice?.() !== undefined
                ? { voice: this.options.audioVoice!() }
                : {}),
              format: this.options.audioFormat?.() ?? 'wav',
            },
          }
        : {}),
      ...request.options,
      ...(this.options.extraBody?.(request) ?? {}),
    }
    const response = await (this.options.fetch ?? fetch)(this.options.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
        ...this.options.headers,
      },
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    })
    if (response.status === 401 || response.status === 403) {
      throw new MediaExecutionError(
        `OpenRouter rejected the key (HTTP ${response.status})`,
        'AUTH',
        response.status,
      )
    }
    if (!response.ok) {
      throw new MediaExecutionError(
        `the OpenRouter request failed (HTTP ${response.status})`,
        response.status >= 500 ? 'SERVER' : 'CLIENT',
        response.status,
      )
    }
    let payload: unknown
    try {
      payload = JSON.parse(
        new TextDecoder().decode(
          await readMediaResponse(
            response,
            this.options.maxResponseBytes ?? 134217728,
            signal ?? AbortSignal.timeout(300000),
          ),
        ),
      )
    } catch {
      throw new MediaExecutionError('OpenRouter returned invalid or oversized JSON', 'NO_OUTPUT')
    }
    const raw = rawOf(payload)
    return {
      files: [],
      ...(companionText(raw) !== undefined ? { text: companionText(raw) } : {}),
      raw,
    }
  }
}

/**
 * Build the multimodal user content: the prompt, input images as
 * `image_url` parts (http(s) or data: URLs — the executor inlines local
 * paths), and input audio as `input_audio` parts.
 */
export function buildContent(request: Omit<MediaGenerateRequest, 'output'>): ContentPart[] {
  const parts: ContentPart[] = [{ type: 'text', text: request.prompt }]
  for (const input of request.inputs ?? []) {
    if (input.kind === 'image') {
      parts.push({ type: 'image_url', image_url: { url: input.url } })
      continue
    }
    if (input.kind === 'audio') {
      parts.push({
        type: 'input_audio',
        input_audio: {
          data: dataUrlPayload(input.url),
          format: audioFormatOf(input.url),
        },
      })
      continue
    }
    if (input.kind === 'video') {
      parts.push({ type: 'video_url', video_url: { url: input.url } })
    }
  }
  return parts
}

/** Normalize a chat response into the harvester's vocabulary. */
function rawOf(payload: unknown): unknown {
  const choice = (payload as { choices?: unknown[] })?.choices?.[0]
  const message = (choice as { message?: unknown })?.message
  if (typeof message !== 'object' || message === null) {
    return { error: (payload as { error?: unknown })?.error ?? payload }
  }
  const record = message as Record<string, unknown>
  return {
    ...(Array.isArray(record.images) ? { images: record.images } : {}),
    ...(typeof record.audio === 'object' && record.audio !== null ? { audio: record.audio } : {}),
    ...(typeof record.content === 'string' && record.content.length > 0
      ? { text: record.content }
      : {}),
  }
}

function companionText(raw: unknown): string | undefined {
  const text = (raw as { text?: unknown })?.text
  return typeof text === 'string' && text.length > 0 ? text : undefined
}

function dataUrlPayload(url: string): string {
  const comma = url.indexOf(',')
  return url.startsWith('data:') && comma > 0 ? url.slice(comma + 1) : url
}

function audioFormatOf(url: string): string {
  const match = /^data:audio\/([a-z0-9]+);/i.exec(url)
  if (match !== null) return match[1]!.toLowerCase() === 'mpeg' ? 'mp3' : match[1]!.toLowerCase()
  const dot = url.split(/[?#]/, 1)[0]!.lastIndexOf('.')
  return dot > 0 ? url.slice(dot + 1).toLowerCase() : 'wav'
}
