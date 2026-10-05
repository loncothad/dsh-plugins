import type { EvidenceVerdict } from './evidence.ts'
import type { Environment, PolicyDecision } from './policy.ts'
export interface EvidenceAuthority {
  currentTarget(sessionId: string): string
  check(sessionId: string, contractId?: string): EvidenceVerdict
  refresh(sessionId: string): Promise<void>
}
export interface EnvironmentAuthority {
  identity: string
  environment: Environment
  valid: boolean
  reason: string
  scope(sessionId: string): string
  assert(): void
}
export interface SecretsAuthority {
  withCredentials<T>(
    consumer: string,
    sessionId: string,
    references: readonly string[],
    signal: AbortSignal,
    operation: (values: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<T>,
  ): Promise<T>
  redact(text: string): string
}
export interface PolicyAuthority {
  inspect(sessionId: string, tool: string, args: unknown): PolicyDecision
}
export interface ExecutionAuthority {
  run<T>(
    input: {
      id: string
      sessionId: string
      kind: string
      payloadRef: Record<string, unknown>
      retrySafe: boolean
      maxAttempts?: number
    },
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ id: string; value: T }>
  readResult<T>(sessionId: string, id: string, kind: string): Promise<T>
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    evidenceAuthority: EvidenceAuthority
    environmentIsolation: EnvironmentAuthority
    secretsBroker: SecretsAuthority
    policyEngine: PolicyAuthority
    executionRecovery: ExecutionAuthority
  }
}
