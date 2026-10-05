/** Parse human media arguments without executing a shell or altering filesystem backslashes. */
import type { MediaInput, MediaModality } from './media.ts'
import { mergeMediaOptions } from './options.ts'

interface Token {
  value: string
  literal: boolean
}
export interface MediaInvocation {
  model?: string
  output?: MediaModality
  prompt: string
  request: {
    prompt: string
    inputs?: readonly MediaInput[]
    options?: Readonly<Record<string, unknown>>
  }
  error?: string
}
function tokensOf(raw: string): Token[] {
  if (Buffer.byteLength(raw, 'utf8') > 262144)
    throw new Error('Media command exceeds its 256 KiB limit')
  const tokens: Token[] = []
  let position = 0,
    optionsEnded = false
  const whitespace = (char: string | undefined) => char === undefined || /\s/.test(char)
  while (position < raw.length) {
    while (position < raw.length && whitespace(raw[position])) position++
    if (position === raw.length) break
    const start = position,
      first = raw[position]!
    const previous = tokens.at(-1)
    if (
      !optionsEnded &&
      first === '{' &&
      ['--options', '--asset'].includes(previous?.value ?? '') &&
      !previous?.literal
    ) {
      const stack: string[] = []
      let quoted = false,
        escaped = false
      for (; position < raw.length; position++) {
        const char = raw[position]!
        if (quoted) {
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') quoted = false
          continue
        }
        if (char === '"') quoted = true
        else if (char === '{' || char === '[') {
          stack.push(char === '{' ? '}' : ']')
          if (stack.length > 32) throw new Error('--options exceeds its JSON nesting limit')
        } else if (char === '}' || char === ']') {
          if (stack.pop() !== char) throw new Error('--options needs a valid JSON object')
          if (!stack.length) {
            position++
            break
          }
        }
      }
      if (stack.length || quoted || !whitespace(raw[position]))
        throw new Error('--options needs a complete JSON object followed by whitespace')
      tokens.push({ value: raw.slice(start, position), literal: true })
    } else if (first === '"' || first === "'") {
      const quote = first
      let value = '',
        closed = false
      position++
      for (; position < raw.length; position++) {
        const char = raw[position]!
        if (char === '\\' && raw[position + 1] === quote) {
          value += quote
          position++
          continue
        }
        if (char === quote) {
          position++
          closed = true
          break
        }
        value += char
      }
      if (!closed) throw new Error('Unterminated quoted media argument')
      if (!whitespace(raw[position]))
        throw new Error('Quoted media arguments must be separated by whitespace')
      tokens.push({ value, literal: true })
    } else {
      let value = ''
      while (position < raw.length && !whitespace(raw[position])) {
        if (raw[position] === '\\' && position + 1 < raw.length && whitespace(raw[position + 1])) {
          value += raw[position + 1]
          position += 2
        } else value += raw[position++]
      }
      tokens.push({ value, literal: false })
    }
    if (tokens.at(-1)?.value === '--' && !tokens.at(-1)?.literal) optionsEnded = true
    if (tokens.length > 16384) throw new Error('Media command contains too many arguments')
  }
  return tokens
}
export function parseMediaInvocation(raw: string): MediaInvocation {
  const error = (message: string): MediaInvocation => ({
    prompt: '',
    request: { prompt: '' },
    error: message,
  })
  let tokens: Token[]
  try {
    tokens = tokensOf(raw)
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : 'Invalid media arguments')
  }
  if (!tokens.length)
    return error(
      'Usage: [@model] prompt [--output text|image|video|audio|3d] [--image PATH] [--video PATH] [--audio PATH] [--asset JSON] [--3d PATH] [--options JSON]',
    )
  let model: string | undefined,
    output: MediaModality | undefined,
    options: Readonly<Record<string, unknown>> | undefined
  if (!tokens[0]!.literal && tokens[0]!.value.startsWith('@')) {
    model = tokens.shift()!.value.slice(1)
    if (!model) return error('@ requires a model ID')
  }
  const inputs: MediaInput[] = [],
    prompt: string[] = []
  let literal = false
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (!literal && !token.literal && token.value === '--') {
      literal = true
      continue
    }
    if (literal || token.literal || !token.value.startsWith('--')) {
      prompt.push(token.value)
      continue
    }
    if (
      !['--output', '--image', '--video', '--audio', '--3d', '--options', '--asset'].includes(
        token.value,
      )
    )
      return error(
        `Unknown media flag ${token.value}; use -- before literal prompt text beginning with --`,
      )
    const value = tokens[++index]
    if (!value?.value || (!value.literal && value.value.startsWith('--')))
      return error(`${token.value} requires a value`)
    if (token.value === '--output') {
      if (output !== undefined) return error('--output may be supplied only once')
      if (!['text', 'image', 'video', 'audio', '3d'].includes(value.value))
        return error('--output requires text, image, video, audio, or 3d')
      output = value.value as MediaModality
    } else if (token.value === '--options') {
      if (options !== undefined) return error('--options may be supplied only once')
      try {
        options = mergeMediaOptions(undefined, JSON.parse(value.value))
      } catch {
        return error('--options needs a bounded JSON object containing finite values')
      }
    } else if (token.value === '--asset') {
      try {
        const asset = JSON.parse(value.value)
        if (
          !asset ||
          typeof asset !== 'object' ||
          Array.isArray(asset) ||
          Object.keys(asset).some((key) => !['kind', 'url', 'path'].includes(key)) ||
          !['image', 'video', 'audio', '3d'].includes(asset.kind) ||
          typeof asset.url !== 'string' ||
          !asset.url ||
          (asset.path !== undefined &&
            (!Array.isArray(asset.path) ||
              !asset.path.length ||
              asset.path.length > 16 ||
              asset.path.some((part: unknown) =>
                typeof part === 'string'
                  ? !part || ['__proto__', 'prototype', 'constructor'].includes(part)
                  : !Number.isSafeInteger(part) || Number(part) < 0 || Number(part) > 63,
              )))
        )
          return error('--asset requires {kind, url, path?} with a bounded model input path')
        inputs.push(asset)
      } catch {
        return error('--asset needs a JSON object')
      }
    } else
      inputs.push({
        kind: token.value.slice(2) as 'image' | 'video' | 'audio' | '3d',
        url: value.value,
      })
    if (inputs.length > 8) return error('Media commands accept at most eight source assets')
  }
  const text = prompt.join(' ')
  if (!text.trim() && !inputs.length) return error('The prompt or a source asset is required')
  return {
    model,
    output,
    prompt: text,
    request: {
      prompt: text,
      ...(inputs.length ? { inputs } : {}),
      ...(options !== undefined ? { options } : {}),
    },
  }
}
