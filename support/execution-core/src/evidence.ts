export type ConfidenceState = 'verified' | 'unverified' | 'insufficient_evidence'
export type RefusalKind =
  | 'safety_refusal'
  | 'missing_permissions'
  | 'missing_evidence'
  | 'unsupported_capability'
  | 'transient_failure'
export interface Refusal {
  kind: RefusalKind
  code: string
  message: string
  retryable: boolean
  requirements?: string[]
}
export interface EvidenceReceipt {
  id: string
  target: string
  kind: 'source' | 'database-read' | 'verifier' | 'model-verifier' | 'human-review'
  origin: string
  contentHash: string
  recordedAt: number
  passed: boolean
  verifierId?: string
}
export interface EvidenceContract {
  id: string
  minimumIndependentSources: number
  freshnessMs: number
  requireDatabaseRead: boolean
  verifiers: string[]
  requireModelVerifier: boolean
  requireHumanReview: boolean
}
export interface EvidenceVerdict {
  state: ConfidenceState
  missing: string[]
  receiptIds: string[]
}
export function evaluateEvidence(
  contract: EvidenceContract,
  receipts: readonly EvidenceReceipt[],
  target: string,
  now: number,
): EvidenceVerdict {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(contract.minimumIndependentSources) ||
    contract.minimumIndependentSources < 0 ||
    contract.minimumIndependentSources > 128 ||
    !Number.isSafeInteger(contract.freshnessMs) ||
    contract.freshnessMs < 1 ||
    contract.verifiers.length > 32 ||
    new Set(contract.verifiers).size !== contract.verifiers.length
  )
    throw new Error('Invalid evidence contract')
  const eligible = receipts.filter(
    (row) =>
      row.target === target &&
      row.passed &&
      Number.isSafeInteger(row.recordedAt) &&
      row.recordedAt <= now &&
      now - row.recordedAt <= contract.freshnessMs,
  )
  const sources = new Map<string, EvidenceReceipt>(),
    hashes = new Set<string>()
  for (const row of eligible.filter((row) => row.kind === 'source'))
    if (row.origin && !sources.has(row.origin) && !hashes.has(row.contentHash)) {
      sources.set(row.origin, row)
      hashes.add(row.contentHash)
    }
  const missing: string[] = []
  if (sources.size < contract.minimumIndependentSources)
    missing.push(
      `${contract.minimumIndependentSources} independent source origins with distinct content (${sources.size} available)`,
    )
  if (contract.requireDatabaseRead && !eligible.some((row) => row.kind === 'database-read'))
    missing.push('fresh database-read receipt')
  for (const verifier of contract.verifiers)
    if (
      !eligible.some(
        (row) =>
          (row.kind === 'verifier' || row.kind === 'database-read') && row.verifierId === verifier,
      )
    )
      missing.push(`verifier pass: ${verifier}`)
  if (contract.requireModelVerifier && !eligible.some((row) => row.kind === 'model-verifier'))
    missing.push('separate model verifier pass')
  if (contract.requireHumanReview && !eligible.some((row) => row.kind === 'human-review'))
    missing.push('human review of the exact target')
  // A generative validator is an opinion. Alone it cannot certify consequential work.
  const grounded =
    contract.minimumIndependentSources > 0 ||
    contract.requireDatabaseRead ||
    contract.verifiers.length > 0 ||
    contract.requireHumanReview
  return {
    state: missing.length ? 'insufficient_evidence' : grounded ? 'verified' : 'unverified',
    missing,
    receiptIds: eligible.map((row) => row.id),
  }
}
export function refusal(
  kind: RefusalKind,
  code: string,
  message: string,
  requirements?: string[],
): Refusal {
  return {
    kind,
    code,
    message,
    retryable: kind === 'transient_failure',
    ...(requirements ? { requirements } : {}),
  }
}
