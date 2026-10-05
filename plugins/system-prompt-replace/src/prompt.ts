/**
 * The replacement-prompt domain: resolving the prompt text from exactly
 * one source (an inline string or a file). Pure domain — no harness
 * imports.
 *
 * @module @loncothad/dsh-system-prompt-replace/prompt
 */

import { readFileSync } from 'node:fs'

/** File surface, injected in tests. */
export interface PromptIo {
  read(path: string): string
}

/** The default file surface over node:fs. */
export const defaultPromptIo: PromptIo = {
  read(path) {
    return readFileSync(path, 'utf8')
  },
}

/** Resolved replacement prompt. */
export interface ResolvedPrompt {
  /** The resolved text. */
  readonly text: string
  /** Human-readable source label for diagnostics. */
  readonly source: string
}

/**
 * Resolve the replacement prompt. Exactly one source may be configured:
 * `prompt` (inline) or `file`. The file is read once at registration; a
 * deployment reload (config edit, HMR) re-resolves it.
 */
export function resolvePrompt(
  config: {
    prompt?: string
    file?: string
  },
  io: PromptIo = defaultPromptIo,
): ResolvedPrompt {
  const inline = config.prompt !== undefined && config.prompt.length > 0
  const file = config.file !== undefined && config.file.length > 0
  if (inline && file) {
    throw new Error('configure either the inline prompt or the prompt file, not both')
  }
  if (inline) {
    return { text: config.prompt!, source: 'config' }
  }
  if (file) {
    const path = config.file!
    let text: string
    try {
      text = io.read(path)
    } catch (error: unknown) {
      throw new Error(`cannot read the prompt file ${path}: ${String(error)}`)
    }
    if (text.trim().length === 0) {
      throw new Error(`the prompt file ${path} is empty`)
    }
    return { text, source: path }
  }
  throw new Error('no replacement prompt configured: set the inline prompt or the prompt file')
}
