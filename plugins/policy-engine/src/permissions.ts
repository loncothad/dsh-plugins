/** Deliberately narrow similarity families, never a shell-prefix permission. */
import { resolve } from 'node:path'
import { fingerprint, type PolicyDecision } from '@loncothad/dsh-execution-core'
import { z } from 'zod'
export const grantSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
    sessionId: z.string().max(128),
    label: z.string().max(256),
    workspace: z.string().max(4096),
    environment: z.string().max(16),
    mode: z.string().max(128),
    expiresAt: z.number().finite(),
    createdAt: z.number().finite(),
  })
  .strict()
export const permissionsSchema = z.object({ grants: z.array(grantSchema).max(32) }).strict()
export type Grant = z.infer<typeof grantSchema>
export interface ActionScope {
  sessionId: string
  environment: string
  workspace: string
  mode: string
  boundary: string
}
export interface Similarity {
  signature: string
  label: string
  workspace: string
}
/** Directory metadata only. File reads, Git helpers, pipelines and executable substitutions are not grouped. */
export function inspectionCommands(command: string): boolean {
  if (
    !command ||
    command.length > 8192 ||
    command.includes(String.fromCharCode(0)) ||
    /[\n\r$`<>|&\\*?{}()[\]]/.test(command)
  )
    return false
  const parts = command.split(';').map((p) => p.trim())
  if (!parts.length || parts.length > 8 || parts.some((p) => !p)) return false
  return parts.every((part) => {
    const args = part.split(/\s+/),
      name = args.shift()
    return name === 'pwd'
      ? args.every((a) => a === '-P' || a === '-L')
      : name === 'ls' && args.every((a) => /^-[aAlhtr1dFpn]+$/.test(a))
  })
}
export function similarity(
  tool: string,
  args: unknown,
  scope: ActionScope,
  policyHash: string,
): Similarity | undefined {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    JSON.stringify(args).length > 32768
  )
    return
  const data = args as Record<string, unknown>
  if (data.sandbox_permissions !== undefined || data.run_in_background === true) return
  const workdir =
    typeof data.workdir === 'string' ? resolve(scope.workspace, data.workdir) : scope.workspace
  const normalized = { ...data }
  delete normalized.description
  const inspection =
    tool === 'bash' &&
    typeof data.command === 'string' &&
    workdir === scope.workspace &&
    inspectionCommands(data.command)
  return {
    signature: fingerprint({
      scope: { ...scope, workspace: workdir },
      policyHash,
      tool,
      family: inspection ? 'workspace-inspection' : normalized,
    }),
    label: inspection
      ? 'Directory listings in this workspace'
      : `The same ${tool} action in this workspace`,
    workspace: workdir,
  }
}
export function matchesGrant(
  grant: Grant,
  candidate: Similarity,
  scope: ActionScope,
  policyHash: string,
  decision: PolicyDecision,
  now = Date.now(),
): boolean {
  return (
    decision.effect === 'require_review' &&
    grant.sessionId === scope.sessionId &&
    grant.policyHash === policyHash &&
    grant.signature === candidate.signature &&
    grant.expiresAt > now
  )
}
