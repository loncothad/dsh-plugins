import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { FRAME_LIMIT } from './codec.ts'

/** Bound allocation before reading a potentially damaged archive file. */
export function readFrameFile(path: string): Buffer {
  const file = openSync(path, 'r')
  try {
    const size = fstatSync(file)
    if (!size.isFile() || size.size > FRAME_LIMIT || size.size < 44)
      throw new Error('Invalid evidence archive file size')
    const bytes = Buffer.alloc(size.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(file, bytes, offset, bytes.length - offset, null)
      if (!count) throw new Error('Evidence archive file was truncated')
      offset += count
    }
    return bytes
  } finally {
    closeSync(file)
  }
}
