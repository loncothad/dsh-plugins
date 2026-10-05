import type {
  RemoteResult,
  TypertCodec,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
export interface EvidenceView {
  installed: string[]
  installing: boolean
  error: string
  workspaces: number
  sessions: number
  extractionEnabled: boolean
}
export interface EvidenceControlRemote {
  state(): Promise<RemoteResult<EvidenceView>>
  install(): Promise<RemoteResult<EvidenceView>>
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    evidenceControl: EvidenceControlRemote
  }
}
export function parseEvidenceView(value: unknown): EvidenceView {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid compactor state')
  const row = value as Record<string, unknown>
  if (
    !Array.isArray(row.installed) ||
    row.installed.length > 128 ||
    row.installed.some((value) => typeof value !== 'string' || value.length > 256) ||
    typeof row.installing !== 'boolean' ||
    typeof row.extractionEnabled !== 'boolean' ||
    typeof row.error !== 'string' ||
    row.error.length > 4096 ||
    !Number.isSafeInteger(row.workspaces) ||
    Number(row.workspaces) < 0 ||
    !Number.isSafeInteger(row.sessions) ||
    Number(row.sessions) < 0
  )
    throw new TypeError('Invalid compactor state')
  return {
    installed: row.installed as string[],
    installing: row.installing,
    error: row.error,
    workspaces: Number(row.workspaces),
    sessions: Number(row.sessions),
    extractionEnabled: row.extractionEnabled,
  }
}
const result: TypertCodec = {
  mode: 'strict',
  typeSymbol: '@loncothad/dsh-evidence-compactor/control#EvidenceView',
  create: () => ({ parse: parseEvidenceView }),
}
export const controlContribution: TypertRemoteContribution = {
  package: '@loncothad/dsh-evidence-compactor.control',
  descriptors: ['state', 'install'].map((method) => ({
    id: `evidenceControl/${method}`,
    namespace: 'evidenceControl',
    service: 'evidenceControl',
    method,
    invocation: { kind: 'direct' },
    parameters: [],
    result,
  })),
}
