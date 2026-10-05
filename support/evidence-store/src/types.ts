import type { ReplayValue } from './replay.ts'
export interface Scope {
  workspaceId: string
  sessionId: string
}
export interface CapturedEvent {
  id: string
  role: string
  group: string
  closed: boolean
  text: string
  metadata?: Record<string, unknown>
}
export interface EvidenceHit {
  id: number
  eventId: string
  objectId: string
  startByte: number
  endByte: number
  quote: string
  role: string
  seq: number
  previousId?: number
  nextId?: number
}
export interface CaptureResult {
  eventId: string
  seq: number
  evidenceIds: number[]
}
export interface StoreStatus {
  sqliteVersion: string
  events: number
  objects: number
  spans: number
  archiveFileObjects: number
  rawBytes: number
  storedBytes: number
  allocatedBytes: number
  allocatedBytesComplete: boolean
}
export interface ExtractionDiagnostics {
  queued: number
  running: number
  complete: number
  gaps: number
  reservedUsd: number
  unknownBillingAttempts: number
  recentGaps: { jobId: string; reason: string }[]
}
export interface SourceState {
  head: number
  revision: number
  controlRevision: number
  policyRevision: number
}
export interface ControlRecord {
  id: string
  kind: 'pin' | 'task' | 'approval' | 'supersession'
  role: 'user' | 'developer' | 'system'
  text: string
}
export interface ExtractionPolicy {
  enabled: boolean
  provider: string
  model: string
  promptVersion: string
  budgetUsd: number
  inputUsdPerMillion?: number
  outputUsdPerMillion?: number
  allowUnknownBilling: boolean
}
export interface ExtractionJob {
  instructionHash: string
  extractorVersion: string
  id: string
  scope: Scope
  state: SourceState
  evidenceIds: number[]
  sourceTokens: number
  provider: string
  model: string
  promptVersion: string
  attempt: number
  leaseToken?: string
  leaseUntil?: number
}
export interface JobReport {
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  unknownBilling: boolean
  gap?: string
}
export interface ManifestInput {
  request: ReplayValue
  state: SourceState
  selected: { id: string; mode: 'original' | 'masked'; evidenceIds: number[] }[]
  atomIds: string[]
  requestHash: string
  inputTokens: number
  rendererVersion: string
  adapterVersion: string
}
export interface Manifest extends ManifestInput {
  id: string
  scope: Scope
  generation: number
}
export interface ColdObject {
  id: string
  length: number
  bytes: Uint8Array
  revision: number
  generation: number
}
export interface CompressedObject {
  codec: 'gzip' | 'zstd'
  frame: Uint8Array
  path?: string
}
export type StoreCommand =
  | { op: 'capture'; scope: Scope; event: CapturedEvent }
  | { op: 'search'; scope: Scope; query: string; limit: number }
  | { op: 'read'; scope: Scope; ids: number[] }
  | { op: 'delete'; scope: Scope; eventId: string }
  | { op: 'deleted'; scope: Scope; eventIds: string[] }
  | { op: 'manifest-available'; scope: Scope; id: string }
  | { op: 'retire'; before: number; protectedSessions: string[]; limit: number }
  | { op: 'state'; scope: Scope }
  | { op: 'seal'; scope: Scope; group: string }
  | { op: 'controls'; scope: Scope; expectedRevision: number; records: ControlRecord[] }
  | { op: 'read-controls'; scope: Scope; revision?: number }
  | { op: 'policy'; scope: Scope; policy: ExtractionPolicy }
  | { op: 'pending'; scope: Scope; limit: number }
  | { op: 'enqueue'; scope: Scope; evidenceIds: number[]; sourceTokens: number }
  | { op: 'claim'; scope: Scope }
  | { op: 'diagnostics'; scope: Scope }
  | { op: 'publish'; scope: Scope; job: ExtractionJob; payload: unknown; report: JobReport }
  | { op: 'gap'; scope: Scope; job: ExtractionJob; report: JobReport; retry: boolean }
  | { op: 'atoms'; scope: Scope; limit: number }
  | { op: 'manifest'; scope: Scope; input: ManifestInput }
  | { op: 'replay'; scope: Scope; id: string }
  | { op: 'replay-request'; scope: Scope; id: string }
  | { op: 'cleanup-orphans'; now: number; limit: number }
  | { op: 'cold'; now: number; limit: number }
  | { op: 'compressed'; candidate: ColdObject; encoded: CompressedObject }
  | { op: 'status' }
  | { op: 'close' }

export function validateScope(scope: Scope, workspaceId: string): void {
  if (scope.workspaceId !== workspaceId || !scope.sessionId || scope.sessionId.length > 512)
    throw new Error('Evidence scope is unavailable')
}
