/** One bounded, independently verifiable compression frame per immutable original object. */
import { createHash } from 'node:crypto'
import * as zlib from 'node:zlib'

export type ObjectCodec = 'raw' | 'gzip' | 'zstd'
export const OBJECT_LIMIT = 256 * 1024
const HEADER = 44
export const FRAME_LIMIT = OBJECT_LIMIT + HEADER
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export function decodeFrame(
  frame: Uint8Array,
  codec: Exclude<ObjectCodec, 'raw'>,
  id: string,
  expectedLength: number,
): Buffer {
  if (
    !Number.isSafeInteger(expectedLength) ||
    expectedLength < 0 ||
    expectedLength > OBJECT_LIMIT ||
    !/^[a-f0-9]{64}$/.test(id) ||
    frame.byteLength < HEADER ||
    frame.byteLength > FRAME_LIMIT
  )
    throw new Error('Invalid evidence frame bounds')
  const input = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)
  if (
    input.toString('ascii', 0, 4) !== 'EV01' ||
    input[4] !== (codec === 'gzip' ? 1 : 2) ||
    input.readUInt32LE(8) !== expectedLength ||
    input.subarray(12, HEADER).toString('hex') !== id
  )
    throw new Error('Evidence frame metadata is corrupt')
  const options = { maxOutputLength: Math.max(1, expectedLength) }
  const bytes =
    codec === 'gzip'
      ? zlib.gunzipSync(input.subarray(HEADER), options)
      : typeof zlib.zstdDecompressSync === 'function'
        ? zlib.zstdDecompressSync(input.subarray(HEADER), options)
        : (() => {
            throw new Error('This runtime cannot decode persisted Zstandard evidence')
          })()
  if (bytes.length !== expectedLength || sha(bytes) !== id)
    throw new Error('Evidence frame failed its original-byte hash check')
  return bytes
}

/** Zstd level 3 when available; gzip remains a write fallback and a permanent decoder. */
export function encodeFrame(
  bytes: Uint8Array,
  preferred: Exclude<ObjectCodec, 'raw'> = 'zstd',
): { codec: Exclude<ObjectCodec, 'raw'>; frame: Buffer } | undefined {
  if (bytes.byteLength > OBJECT_LIMIT)
    throw new Error('Evidence object exceeds the compression bound')
  if (bytes.byteLength < 4096) return undefined
  const codec =
    preferred === 'zstd' && typeof zlib.zstdCompressSync === 'function' ? 'zstd' : 'gzip'
  const compressed =
    codec === 'zstd'
      ? zlib.zstdCompressSync(bytes, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } })
      : zlib.gzipSync(bytes, { level: 3 })
  if (compressed.length + HEADER > bytes.byteLength * 0.9) return undefined
  const id = sha(bytes)
  const header = Buffer.alloc(HEADER)
  header.write('EV01', 0, 'ascii')
  header[4] = codec === 'gzip' ? 1 : 2
  header.writeUInt32LE(bytes.byteLength, 8)
  Buffer.from(id, 'hex').copy(header, 12)
  const frame = Buffer.concat([header, compressed])
  decodeFrame(frame, codec, id, bytes.byteLength)
  return { codec, frame }
}
