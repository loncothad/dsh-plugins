/** Validate embedded image headers and enforce Cloudflare's decoded byte/pixel limits. */
function dimensions(bytes: Buffer, mime: string): [number, number] {
  if (
    mime === 'image/png' &&
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  if (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break
      while (bytes[offset] === 255) offset++
      const marker = bytes[offset++]!
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length) break
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        length >= 7
      )
        return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)]
      offset += length
    }
  }
  if (
    mime === 'image/webp' &&
    bytes.length >= 30 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const kind = bytes.toString('ascii', 12, 16)
    if (kind === 'VP8X') return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1]
    if (kind === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a])))
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff]
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const data = bytes.readUInt32LE(21)
      return [(data & 0x3fff) + 1, ((data >>> 14) & 0x3fff) + 1]
    }
  }
  throw new Error('Invalid or unsupported embedded PNG, JPEG or WebP image')
}
export function validateImages(
  images: readonly (string | { content_type: string; base64: string })[],
): void {
  if (images.length > 4) throw new Error('Cloudflare supports at most four images')
  let total = 0
  for (const image of images) {
    const match =
      typeof image === 'string'
        ? /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(image)
        : undefined
    const mime = typeof image === 'string' ? match?.[1]?.toLowerCase() : image.content_type
    const base64 = typeof image === 'string' ? match?.[2] : image.base64
    if (
      !mime ||
      !base64 ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(mime) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
    )
      throw new Error('Use embedded base64 images. Remote image URLs are not accepted.')
    const bytes = Buffer.from(base64, 'base64')
    total += bytes.length
    if (bytes.length > 4 * 1024 * 1024 || total > 8 * 1024 * 1024)
      throw new Error('Image input exceeds the decoded byte limit')
    const [width, height] = dimensions(bytes, mime)
    if (!width || !height || width * height > 16000000)
      throw new Error('Image input exceeds sixteen megapixels')
  }
}
