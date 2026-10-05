/** Media files belong to the admitted execution world and session workspace. */

import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { MediaExecutionError, mediaMime } from './executor.ts'
import type { MediaIo } from './media.ts'
import { publishMediaFile } from './publication.ts'

/** Binary publication currently requires the filesystem's explicit shared-host mapping capability. */
export async function scopedMediaIo(
  ctx: Context,
  agent: Agent,
  signal: AbortSignal,
  outDir: string,
  maxInputBytes: number,
  needsWrites = true,
): Promise<MediaIo> {
  const cwd = agent.session.header.cwd
  if (!cwd)
    throw new MediaExecutionError('Media generation requires an agent workspace directory', 'INPUT')
  const fs =
    ctx.get('agentPresets')?.serviceFor(agent, 'fs') ?? agent.ctx.get('fs') ?? ctx.get('fs')
  if (!fs)
    throw new MediaExecutionError('The admitted execution world provides no filesystem', 'INPUT')
  const policy =
    ctx.get('agentPresets')?.serviceFor(agent, 'sandboxPolicy') ??
    agent.ctx.get('sandboxPolicy') ??
    ctx.get('sandboxPolicy')
  if (fs.sandboxMode !== undefined && !policy)
    throw new MediaExecutionError(
      'The confining filesystem has no sandbox policy resolver',
      'INPUT',
    )
  const workspace = await fs.resolve(cwd, { signal })
  const target = async (path: string) => {
    signal.throwIfAborted()
    const resolved = await fs.resolve(path, { cwd, signal })
    if (!fs.contains(workspace, resolved))
      throw new MediaExecutionError(
        'Media paths must remain inside the admitted session workspace',
        'INPUT',
      )
    return resolved
  }
  const outputPath = async (path: string) => {
    const mode = policy?.resolve({ session: agent.session }).mode ?? fs.sandboxMode
    if (mode === 'read-only')
      throw new MediaExecutionError(
        'Media generation requires a writable workspace; the current sandbox policy is read-only',
        'INPUT',
      )
    const resolved = await target(path)
    const uri = new URL(fs.fileUrl(resolved))
    if (uri.protocol !== 'file:')
      throw new MediaExecutionError(
        'This execution world supplies no shared-host binary publication capability',
        'INPUT',
      )
    const hostPath = fileURLToPath(uri)
    if (fs.processPathFromHostPath(hostPath) !== fs.processPath(resolved))
      throw new MediaExecutionError(
        'This execution world does not share the resolved output path with the host',
        'INPUT',
      )
    return hostPath
  }
  // Validate scope and write policy before a paid provider request starts.
  if (needsWrites) await outputPath(outDir)
  return {
    async mkdir(path) {
      await mkdir(await outputPath(path), { recursive: true, mode: 0o700 })
    },
    async write(path, bytes) {
      const hostPath = await outputPath(path)
      return publishMediaFile(hostPath, bytes, signal)
    },
    async readDataUrl(path) {
      const resolved = await target(path)
      const info = await fs.stat(resolved, signal)
      if (info?.type !== 'file' || (info.size !== undefined && info.size > maxInputBytes))
        throw new MediaExecutionError(
          'The media input must be a bounded regular file in this workspace',
          'INPUT',
        )
      const bytes = await fs.readBytes(resolved, signal, maxInputBytes)
      signal.throwIfAborted()
      if (bytes.byteLength > maxInputBytes)
        throw new MediaExecutionError('The media input exceeds its byte limit', 'INPUT')
      return `data:${mediaMime(path)};base64,${Buffer.from(bytes).toString('base64')}`
    },
  }
}
