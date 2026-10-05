/** Native Codex Images protocol, pinned to the supplied latest CLI source. */
export interface ImageGenOptions {
  readonly prompt: string
  readonly size?: string
  readonly quality?: 'auto' | 'low' | 'medium' | 'high'
  readonly background?: string
}
export interface ImageResult {
  readonly base64: string
}
export function buildImageBody(options: ImageGenOptions, model: string): Record<string, unknown> {
  if (!model.trim()) throw new Error('Select a Codex image model before generating images')
  return {
    model,
    prompt: options.prompt,
    n: 1,
    ...(options.size ? { size: options.size } : {}),
    ...(options.quality ? { quality: options.quality } : {}),
    ...(options.background ? { background: options.background } : {}),
  }
}
export function extractImageResult(envelope: {
  data?: readonly { b64_json?: unknown }[]
}): ImageResult {
  if (
    !Array.isArray(envelope.data) ||
    envelope.data.length !== 1 ||
    typeof envelope.data[0]?.b64_json !== 'string' ||
    !envelope.data[0].b64_json
  )
    throw new Error('The Codex response contained no generated image')
  const base64 = envelope.data[0].b64_json
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0)
    throw new Error('Invalid Codex image encoding')
  return { base64 }
}
/** Infer the published file suffix from bytes, never from an unsupported request format. */
export function extensionOf(result: ImageResult): string {
  const bytes = Buffer.from(result.base64.slice(0, 44), 'base64')
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return '.jpg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return '.webp'
  throw new Error('Unsupported Codex image bytes')
}
