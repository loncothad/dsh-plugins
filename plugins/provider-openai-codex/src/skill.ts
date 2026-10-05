/**
 * The agent-facing skill + tool surface: a runtime skill teaching the
 * agent that image generation exists, and the `codex_image.generate` tool
 * that performs it. The skill is what the user asked for — the model sees
 * it in its skills catalog and learns when and how to generate images
 * through the Codex subscription.
 *
 * @module @loncothad/dsh-provider-openai-codex/image-skill
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { type CodexImageExecutorOptions, generateImage } from './executor.ts'
import { extensionOf, type ImageGenOptions, type ImageResult } from './image.ts'

export type { CodexAccountTokens, CodexImageExecutorOptions } from './executor.ts'
export { generateImage } from './executor.ts'
export type { ImageGenOptions, ImageResult } from './image.ts'
export { buildImageBody, extensionOf, extractImageResult } from './image.ts'

/** The runtime skill's registered name. */
export const SKILL_NAME = 'codex-image-generation'

/** Where generated images land (configurable). */
export const DEFAULT_OUT_DIR = 'codex-images'

/** The skill body: agent-facing instructions for the tool. */
export const SKILL_CONTENT = `Generate images with the ChatGPT subscription through the codex_image_generate tool.

Use this when the user asks to create, draw, or generate an image. The
subscription backend uses the native Images generation endpoint.

How to use:
1. Call codex_image_generate with { prompt, size?, quality?, background? }.
2. The tool returns the written file path; share that path with the user.
3. Prompts should describe subject, style, composition, and mood.

Constraints:
- Only works while a Codex account is signed in (Plugins → ChatGPT Codex → Subscription login).
- Sizes: 1024x1024 (default), 1536x1024 (landscape), 1024x1536 (portrait).
- Quality: auto, low, medium, high. Use background: "transparent" for transparency.
- The backend chooses the output encoding; the saved suffix follows its actual image bytes.`

/** Skill registration payload (passed to ctx.skills.register). */
export function codexImageSkill() {
  return {
    name: SKILL_NAME,
    description: 'Generate images with the ChatGPT subscription (codex_image_generate tool)',
    whenToUse: 'When the user asks to create, draw, or generate an image',
    source: 'runtime' as const,
    content: SKILL_CONTENT,
  }
}

/** I/O surface for writing files (injected in tests). */
export interface ImageIo {
  mkdir(path: string): Promise<void>
  writeFile(path: string, data: Buffer): Promise<void>
}

const defaultIo: ImageIo = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true })
  },
  writeFile: async (path, data) => {
    await writeFile(path, data)
  },
}

/** Executor + output-directory options for the tool. */
export interface CodexImageToolOptions extends CodexImageExecutorOptions {
  /** Directory generated images are written to. */
  readonly outDir?: string
  readonly io?: ImageIo
  readonly ioFor?: (agent: Agent, signal: AbortSignal) => Promise<ImageIo>
}

/** The written outcome both the tool and the /codex-image command return. */
export interface WrittenImage {
  readonly path: string
}

/**
 * Write one generated image under OPTIONS' output directory. The single
 * writer assembly: the tool and the command both funnel through here, so
 * naming, directory creation, and extension selection cannot drift.
 */
export async function writeGeneratedImage(
  options: CodexImageToolOptions,
  result: ImageResult,
): Promise<WrittenImage> {
  const io = options.io ?? defaultIo
  const outDir = options.outDir ?? DEFAULT_OUT_DIR
  if (result.base64 === undefined) {
    throw new Error('The backend returned no inline image bytes')
  }
  await io.mkdir(outDir)
  const path = join(outDir, `codex-image-${randomUUID().slice(0, 8)}${extensionOf(result)}`)
  await io.writeFile(path, Buffer.from(result.base64, 'base64'))
  return {
    path,
  }
}

/**
 * Build the `codex_image_generate` tool: the model calls it with a prompt;
 * the tool runs the Codex subscription request and writes the PNG/JPEG to
 * the output directory, returning the path.
 */
export function createCodexImageTool(options: CodexImageToolOptions): ToolDefinition {
  const tools = defineTool({
    name: 'codex_image_generate',
    description:
      'Generate one image from a text prompt using the ChatGPT subscription. ' +
      'Returns the written file path.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'What to draw: subject, style, composition, mood.',
      },
      size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'] },
      quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] },
      background: { type: 'string', enum: ['transparent', 'opaque', 'auto'] },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const result = value
        return [{ type: 'text', text: `Image written to ${result.path}` }]
      },
    },
    async execute(raw, exec) {
      exec.signal.throwIfAborted()
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Invalid image arguments')
      const args = raw as Record<string, unknown>
      if (
        typeof args.prompt !== 'string' ||
        !args.prompt.trim() ||
        args.prompt.length > 65536 ||
        (args.quality !== undefined &&
          !['auto', 'low', 'medium', 'high'].includes(String(args.quality))) ||
        (args.size !== undefined &&
          !['1024x1024', '1536x1024', '1024x1536', 'auto'].includes(String(args.size))) ||
        (args.background !== undefined &&
          !['transparent', 'opaque', 'auto'].includes(String(args.background)))
      )
        throw new Error('Invalid image prompt or output options')
      const request: ImageGenOptions = {
        prompt: args.prompt,
        ...(typeof args.size === 'string' ? { size: args.size } : {}),
        ...(args.quality !== undefined
          ? { quality: args.quality as ImageGenOptions['quality'] }
          : {}),
        ...(typeof args.background === 'string' ? { background: args.background } : {}),
      }
      if (options.ioFor && !exec.agent)
        throw new Error('Image generation requires an admitted agent workspace')
      const scoped =
        options.ioFor && exec.agent
          ? { ...options, io: await options.ioFor(exec.agent, exec.signal) }
          : options
      const result = await generateImage(scoped, request, exec.signal)
      exec.signal.throwIfAborted()
      const written = await writeGeneratedImage(scoped, result)
      return { path: written.path }
    },
  })

  return tools
}

/** One /codex-image command outcome. */
export interface CodexImageOutcome {
  readonly path?: string
  readonly error?: string
}

/** Execute /codex-image (the human-facing command body). */
export async function runCodexImageCommand(
  options: CodexImageToolOptions,
  prompt: string,
  signal?: AbortSignal,
  agent?: Agent,
): Promise<CodexImageOutcome> {
  try {
    const deadline = signal ?? AbortSignal.timeout(180000)
    if (options.ioFor && !agent)
      throw new Error('Image generation requires an admitted agent workspace')
    const scoped =
      options.ioFor && agent ? { ...options, io: await options.ioFor(agent, deadline) } : options
    const result = await generateImage(scoped, { prompt }, deadline)
    deadline.throwIfAborted()
    return await writeGeneratedImage(scoped, result)
  } catch (error: unknown) {
    return { error: String(error) }
  }
}
