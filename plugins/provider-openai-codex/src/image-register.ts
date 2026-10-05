/**
 * Image-generation capability for the Codex subscription: the
 * `codex_image_generate` model-callable tool and the
 * `codex-image-generation` runtime skill — both spending the signed-in
 * Codex account's subscription, exactly like the reference Codex app.
 * These are capabilities, not model UX: any active model may invoke
 * them, so they register unconditionally. The human `/codex-image`
 * command is model-behavior UX and lives in model-commands.ts, mounted
 * only while a Codex model is the default selection.
 *
 * @module @loncothad/dsh-provider-openai-codex/image-register
 */

import type { Context } from '@deepseek-ai/cordis'
import { scopedMediaIo } from '@loncothad/dsh-media-gen'
import type { CodexImageExecutorOptions } from './executor.ts'
import {
  type CodexImageToolOptions,
  codexImageSkill,
  createCodexImageTool,
  type ImageIo,
} from './skill.ts'

/** Resolved executor options for the image tooling. */
export interface CodexImageOptions
  extends Pick<
    CodexImageExecutorOptions,
    'size' | 'quality' | 'background' | 'timeoutMs' | 'maxResponseBytes'
  > {
  readonly endpoint: string
  readonly model: string
  readonly outDir: string
  /** Resolves the signed-in account per call. */
  readonly tokens: (
    signal?: AbortSignal,
  ) => Promise<{ accessToken: string; accountId?: string } | undefined>
  /** Test injection: HTTP transport. */
  readonly fetch?: typeof fetch
  /** Test injection: file surface. */
  readonly io?: ImageIo
}

/** Options shape the tool accepts (a superset of the executor's). */
export function imageToolOptions(options: CodexImageOptions, ctx?: Context): CodexImageToolOptions {
  return {
    ...(ctx
      ? {
          signal: (() => {
            const controller = new AbortController()
            ctx.effect(
              () => () => controller.abort(new Error('Codex image provider disposed')),
              'codex image: request lifetime',
            )
            return controller.signal
          })(),
        }
      : {}),
    endpoint: options.endpoint,
    model: options.model,
    outDir: options.outDir,
    size: options.size,
    quality: options.quality,
    background: options.background,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    tokens: options.tokens,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.io !== undefined
      ? { io: options.io }
      : ctx
        ? {
            ioFor: async (agent, signal) => {
              const io = await scopedMediaIo(
                ctx,
                agent,
                signal,
                options.outDir,
                options.maxResponseBytes ?? 64 * 1024 * 1024,
              )
              return {
                mkdir: (path) => io.mkdir(path),
                writeFile: async (path, bytes) => {
                  const receipt = await io.write(path, bytes)
                  try {
                    signal.throwIfAborted()
                  } catch (error) {
                    await receipt.rollback()
                    throw error
                  }
                },
              }
            },
          }
        : {}),
  }
}

/**
 * Register the tool and the runtime skill against resolved options. The
 * merged plugin's apply wires the credentials seam and config; tests
 * inject stubs for tokens, transport, and file I/O.
 */
export function registerCodexImage(
  ctx: Context,
  options: CodexImageOptions,
  enabled: { tools?: boolean; skills?: boolean } = {},
): void {
  if (enabled.tools !== false)
    ctx.tools.register(createCodexImageTool(imageToolOptions(options, ctx)))
  if (enabled.skills !== false) ctx.skills.register(codexImageSkill())
}
