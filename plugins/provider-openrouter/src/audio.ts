/** Dedicated OpenRouter speech and transcription protocols with bounded responses. */

import type {
  MediaFetch,
  MediaGenerateRequest,
  MediaGenerateResult,
} from '@loncothad/dsh-media-gen'
import { MediaExecutionError, readMediaResponse, validateMediaBody } from '@loncothad/dsh-media-gen'
import { audioSchema } from './audio-schema.ts'

export interface AudioOptions {
  endpoint: string
  apiKey: string
  headers?: Readonly<Record<string, string>>
  fetch?: MediaFetch
  routing?: Record<string, unknown>
  voice?: string
  maxBytes: number
}

/** Fail before dispatch when this protocol cannot enforce an operator's routing policy. */
export function audioRouting(
  protocol: 'speech' | 'transcription',
  routing: Record<string, unknown> | undefined,
): void {
  if (protocol === 'transcription' && routing && Object.keys(routing).length)
    throw new MediaExecutionError(
      'OpenRouter transcription does not enforce provider pins or per-request privacy routing. Clear the incompatible preference explicitly or choose a chat audio model.',
      'INPUT',
    )
}

export async function generateAudio(
  options: AudioOptions,
  request: MediaGenerateRequest,
  signal: AbortSignal,
): Promise<MediaGenerateResult> {
  const protocol = request.protocol
  if (protocol !== 'speech' && protocol !== 'transcription')
    throw new MediaExecutionError('Select a speech or transcription protocol', 'INPUT')
  audioRouting(protocol, options.routing)
  const extra = request.options ?? {}
  validateMediaBody(request.inputSchema ?? audioSchema(protocol, undefined), extra)
  if (
    Object.keys(extra).some((key) =>
      ['model', 'input', 'input_audio', 'input_references', 'provider', 'stream'].includes(key),
    )
  )
    throw new MediaExecutionError('Audio options cannot replace routing or source inputs', 'INPUT')
  let body: Record<string, unknown>
  const { provider_options, ...parameters } = extra
  const routedProvider = options.routing?.provider
  const provider = {
    ...(routedProvider && typeof routedProvider === 'object' ? routedProvider : {}),
    ...(provider_options ? { options: provider_options } : {}),
  }
  if (protocol === 'speech') {
    if (!request.prompt.trim())
      throw new MediaExecutionError('Speech synthesis needs text input', 'INPUT')
    const assets = request.inputs ?? []
    const audio = assets.filter((asset) => asset.kind === 'audio'),
      images = assets.filter((asset) => asset.kind === 'image')
    if (
      assets.length !== audio.length + images.length ||
      audio.length > 3 ||
      images.length > 1 ||
      (audio.length && images.length)
    )
      throw new MediaExecutionError(
        'Speech references must be one to three audio clips or one image',
        'INPUT',
      )
    body = {
      model: request.model,
      input: request.prompt,
      response_format: 'mp3',
      ...(options.voice ? { voice: options.voice } : {}),
      ...parameters,
      ...(assets.length
        ? {
            input_references: assets.map((asset) =>
              asset.kind === 'image'
                ? { type: 'image_url', image_url: { url: asset.url } }
                : {
                    type: 'input_audio',
                    input_audio: { [asset.url.startsWith('data:') ? 'data' : 'url']: asset.url },
                  },
            ),
          }
        : {}),
      ...options.routing,
    }
    if (!['mp3', 'pcm'].includes(String(body.response_format)))
      throw new MediaExecutionError('Speech format must be mp3 or pcm', 'INPUT')
  } else {
    if (request.inputs?.length !== 1 || request.inputs[0]?.kind !== 'audio')
      throw new MediaExecutionError('Transcription requires exactly one audio asset', 'INPUT')
    const asset = request.inputs[0]
    const inline = /^data:audio\/([^;,]+);base64,([a-z0-9+/]+=*)$/i.exec(asset.url)
    if (!inline && !/^https:\/\//.test(asset.url))
      throw new MediaExecutionError(
        'Transcription requires inline audio or a public HTTPS audio URL',
        'INPUT',
      )
    const formats: Record<string, string> = {
      mpeg: 'mp3',
      'x-wav': 'wav',
      'x-m4a': 'm4a',
      mp4: 'm4a',
      'x-flac': 'flac',
    }
    body = {
      model: request.model,
      input_audio: inline
        ? { data: inline[2], format: formats[inline[1]!] ?? inline[1] }
        : { url: asset.url },
      ...parameters,
    }
    if (body.response_format && !['json', 'verbose_json'].includes(String(body.response_format)))
      throw new MediaExecutionError(
        'Transcription response format must be json or verbose_json',
        'INPUT',
      )
  }
  if (Object.keys(provider).length) body.provider = provider
  const response = await (options.fetch ?? fetch)(options.endpoint, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: {
      ...options.headers,
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok)
    throw new MediaExecutionError(
      `OpenRouter ${protocol} failed (HTTP ${response.status})`,
      response.status === 401 || response.status === 403
        ? 'AUTH'
        : response.status >= 500
          ? 'SERVER'
          : 'CLIENT',
      response.status,
    )
  const bytes = await readMediaResponse(response, options.maxBytes, signal)
  if (protocol === 'transcription') {
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new MediaExecutionError('Transcription returned invalid JSON', 'NO_OUTPUT')
    }
    if (!raw || typeof raw !== 'object' || !('text' in raw) || typeof raw.text !== 'string')
      throw new MediaExecutionError('Transcription returned no text', 'NO_OUTPUT')
    return {
      files: [],
      text: body.response_format === 'verbose_json' ? JSON.stringify(raw, null, 2) : raw.text,
      raw,
    }
  }
  const format = String(body.response_format)
  if (!['mp3', 'pcm'].includes(format))
    throw new MediaExecutionError('Speech format must be mp3 or pcm', 'INPUT')
  const mime = format === 'mp3' ? 'audio/mpeg' : 'audio/pcm'
  const artifact = 'dsh-media:speech-result'
  return {
    files: [],
    raw: { protocol, mime, generationId: response.headers.get('x-generation-id') },
    artifacts: [{ url: artifact, mime, modality: 'audio' }],
    loadArtifact: async (url, limit, downloadSignal) => {
      downloadSignal.throwIfAborted()
      if (url !== artifact || bytes.byteLength > limit)
        throw new MediaExecutionError('Speech output exceeds its publication limit', 'NO_OUTPUT')
      return bytes
    },
  }
}
