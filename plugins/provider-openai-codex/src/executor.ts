import { randomUUID } from 'node:crypto'
import { readMediaResponse } from '@loncothad/dsh-media-gen'
import { getPiUserAgent } from '@loncothad/dsh-plugin-runtime'
import { CODEX_ORIGINATOR } from './oauth.ts'
/**
 * Image generation executor: one authenticated non-streaming Responses
 * call to the ChatGPT Codex backend with the signed-in account's tokens,
 * returning the generated image bytes.
 *
 * @module @loncothad/dsh-provider-openai-codex/image-executor
 */

import {
  buildImageBody,
  extractImageResult,
  type ImageGenOptions,
  type ImageResult,
} from './image.ts'

/** The signed-in Codex account the executor spends. */
export interface CodexAccountTokens {
  readonly accessToken: string
  readonly accountId?: string
}

/** Executor options. */
export interface CodexImageExecutorOptions {
  /** ChatGPT Codex Responses endpoint. */
  readonly endpoint: string
  /** Model id sent with the request (Codex subscription models). */
  readonly model: string
  /** Resolves the signed-in account per call; undefined → AUTH failure. */
  readonly tokens: (signal?: AbortSignal) => Promise<CodexAccountTokens | undefined>
  /** HTTP transport override for tests. */
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
  readonly maxResponseBytes?: number
  readonly timeoutMs?: number
  readonly size?: string
  readonly quality?: ImageGenOptions['quality']
  readonly background?: string
}

const USER_AGENT = getPiUserAgent()

/** Run one image generation through the Codex subscription. */
export async function generateImage(
  options: CodexImageExecutorOptions,
  request: ImageGenOptions,
  signal?: AbortSignal,
): Promise<ImageResult> {
  if (!options.model.trim())
    throw new Error('Select a Codex image model in Plugins before generating images')
  signal = AbortSignal.any([
    signal ?? new AbortController().signal,
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(options.timeoutMs ?? 180000),
  ])
  signal.throwIfAborted()
  const tokens = await options.tokens(signal)
  signal.throwIfAborted()
  if (tokens === undefined) {
    throw new Error(
      'no Codex account is signed in; sign in from Plugins → ChatGPT Codex → Subscription login',
    )
  }
  const body = buildImageBody(
    { size: options.size, quality: options.quality, background: options.background, ...request },
    options.model,
  )
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(options.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
        originator: CODEX_ORIGINATOR,
        'x-codex-image-turn-id': randomUUID(),
        ...(tokens.accountId !== undefined ? { 'chatgpt-account-id': tokens.accountId } : {}),
      },
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch {
    if (signal.aborted) throw signal.reason
    throw new Error('Codex image transport failed')
  }
  const bytes = await readMediaResponse(
    response,
    options.maxResponseBytes ?? 64 * 1024 * 1024,
    signal,
  )
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error('Codex image response was not JSON')
  }
  if (!response.ok) {
    const detail = errorMessage(payload)
    throw new Error(
      detail !== undefined && detail.length > 0
        ? detail.replaceAll(tokens.accessToken, '[redacted]')
        : `the Codex image request failed (HTTP ${response.status})`,
    )
  }
  return extractImageResult(payload as never)
}

function errorMessage(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const error = (payload as Record<string, unknown>).error
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  if (typeof error === 'string') return error
  return undefined
}
