/** Bounded local Git snapshots; no external diff/textconv helpers and no repository writes. */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-fs'
import { type Evidence, hash, redact } from './domain.ts'
export async function workspaceEvidence(
  ctx: Context,
  agent: Agent,
  signal: AbortSignal,
  limit: number,
): Promise<Evidence | undefined> {
  const cwd = agent.session.header.cwd
  if (!cwd) return
  const fs = ctx.get('agentPresets')?.serviceFor(agent, 'fs') ?? agent.ctx.get('fs')
  if (!fs) throw Error('Workspace review requires the admitted filesystem')
  const resolved = await fs.resolve(cwd, { signal }),
    url = new URL(fs.fileUrl(resolved))
  if (url.protocol !== 'file:')
    throw Error('Workspace review is unavailable in this execution world')
  const host = fileURLToPath(url)
  if (fs.processPathFromHostPath(host) !== fs.processPath(resolved))
    throw Error('Workspace review requires an explicit shared-host mapping')
  const diff = await new Promise<string>((resolve, reject) =>
    execFile(
      'git',
      [
        '--no-pager',
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-C',
        host,
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--unified=2',
        'HEAD',
        '--',
        '.',
        ':(exclude)**/.env*',
        ':(exclude).env*',
        ':(exclude)**/.credentials*',
        ':(exclude)**/.npmrc',
        ':(exclude)**/*private*key*',
        ':(exclude)**/id_rsa',
        ':(exclude)**/id_ed25519',
      ],
      {
        signal,
        timeout: 10000,
        maxBuffer: Math.max(4096, limit * 4),
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
      },
      (error, stdout) =>
        error ? reject(Error('Git snapshot unavailable or exceeds its bound')) : resolve(stdout),
    ),
  )
  if (!diff.trim()) return
  const text = redact(diff).slice(0, limit),
    digest = hash(text)
  return {
    id: `workspace:${digest}`,
    sessionId: agent.session.id,
    seq: agent.session.snapshotEvents().at(-1)?.seq ?? 0,
    hash: digest,
    text,
    truncated: diff.length > limit,
    kind: 'workspace-diff',
  }
}
