/** Compression and file publication stay outside the storage worker and its transaction path. */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { parentPort } from 'node:worker_threads'
import { decodeFrame, encodeFrame } from './codec.ts'
import { readFrameFile } from './frame-file.ts'
import type { ColdObject } from './types.ts'

if (!parentPort) throw new Error('Evidence compression must run in a worker')
parentPort.on(
  'message',
  ({
    id,
    candidate,
    directory,
    preferred,
  }: {
    id: number
    candidate: ColdObject
    directory?: string
    preferred: 'gzip' | 'zstd'
  }) => {
    let temporary: string | undefined
    try {
      const encoded = encodeFrame(candidate.bytes, preferred)
      if (!encoded) {
        parentPort!.postMessage({ id })
        return
      }
      decodeFrame(encoded.frame, encoded.codec, candidate.id, candidate.length)
      if (!directory) {
        parentPort!.postMessage({ id, result: encoded })
        return
      }
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const name = `${candidate.id}.${encoded.codec}.ev`
      const destination = join(directory, name)
      if (existsSync(destination))
        decodeFrame(readFrameFile(destination), encoded.codec, candidate.id, candidate.length)
      else {
        temporary = join(directory, `${candidate.id}.${randomUUID()}.tmp`)
        const file = openSync(temporary, 'wx', 0o600)
        try {
          writeFileSync(file, encoded.frame)
          fsyncSync(file)
        } finally {
          closeSync(file)
        }
        renameSync(temporary, destination)
        temporary = undefined
      }
      let inline = false
      try {
        const folder = openSync(directory, 'r')
        try {
          fsyncSync(folder)
        } finally {
          closeSync(folder)
        }
      } catch (error) {
        // A filesystem without a directory durability barrier uses an atomic FULL SQLite blob update.
        const code = (error as NodeJS.ErrnoException).code
        if (!['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(code ?? '')) throw error
        inline = true
      }
      parentPort!.postMessage({ id, result: { ...encoded, path: inline ? undefined : name } })
    } catch (error) {
      parentPort!.postMessage({
        id,
        error: error instanceof Error ? error.message : 'Evidence compression failed',
      })
    } finally {
      if (temporary)
        try {
          unlinkSync(temporary)
        } catch {}
    }
  },
)
