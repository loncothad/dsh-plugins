/** Exclusive file publication with an identity-checked rollback capability. */

import type { BigIntStats } from 'node:fs'
import { lstat, open, unlink } from 'node:fs/promises'
import type { MediaPublication } from './media.ts'

const same = (left: BigIntStats, right: BigIntStats) =>
  left.isFile() &&
  right.isFile() &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs

export async function publishMediaFile(
  path: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<MediaPublication> {
  signal?.throwIfAborted()
  const handle = await open(path, 'wx', 0o600)
  let identity: BigIntStats
  try {
    await handle.writeFile(bytes)
    signal?.throwIfAborted()
    await handle.sync()
    identity = await handle.stat({ bigint: true })
  } catch (error) {
    // Even a failed write owns its newly-created inode; never unlink a replacement.
    try {
      let owned: BigIntStats
      try {
        owned = await handle.stat({ bigint: true })
      } finally {
        await handle.close()
      }
      const current = await lstat(path, { bigint: true }).catch((cause) => {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw cause
      })
      if (current && !same(current, owned))
        throw new Error('Generated file changed during publication; cleanup refused')
      if (current) await unlink(path)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Media publication failed and cleanup could not safely remove ${path}`,
      )
    }
    throw error
  }
  await handle.close()
  let removed = false
  return {
    async rollback() {
      if (removed) return
      const current = await lstat(path, { bigint: true }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (!current) {
        removed = true
        return
      }
      if (!same(current, identity))
        throw new Error('Generated file changed after publication; rollback refused to remove it')
      await unlink(path)
      removed = true
    },
  }
}
