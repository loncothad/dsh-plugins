import { fingerprint } from './configuration.ts'
import { type EvidenceVerdict, type Refusal, refusal } from './evidence.ts'
export type Environment = 'dev' | 'staging' | 'prod'
export interface PolicyRule {
  id: string
  tools: string[]
  environments: Environment[]
  effect: 'allow' | 'deny' | 'require_review'
  evidenceContract?: string
}
export interface Action {
  tool: string
  arguments: unknown
  environment: Environment
  sessionId: string
  target: string
}
export interface PolicyDecision {
  effect: 'allow' | 'deny' | 'require_review'
  requestHash: string
  ruleIds: string[]
  reason?: Refusal
}
function patternMatches(pattern: string, value: string): boolean {
  if (!pattern || pattern.length > 128 || !/^[a-zA-Z0-9_.*:-]+$/.test(pattern))
    throw new Error('Invalid tool policy pattern')
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(value)
}
/** Denials dominate review; review dominates allow. No matching rule receives the explicit default. */
export function decideAction(
  action: Action,
  rules: readonly PolicyRule[],
  defaultEffect: PolicyRule['effect'],
  evidence: (contract: string) => EvidenceVerdict,
): PolicyDecision {
  if (rules.length > 256 || new Set(rules.map((rule) => rule.id)).size !== rules.length)
    throw new Error('Invalid policy rule set')
  const requestHash = fingerprint(action),
    matches = rules.filter(
      (rule) =>
        rule.environments.includes(action.environment) &&
        rule.tools.some((pattern) => patternMatches(pattern, action.tool)),
    ),
    ruleIds = matches.map((rule) => rule.id)
  const denied = matches.find((rule) => rule.effect === 'deny')
  if (denied)
    return {
      effect: 'deny',
      requestHash,
      ruleIds,
      reason: refusal(
        'missing_permissions',
        'POLICY_DENIED',
        `Rule ${denied.id} denies this action in ${action.environment}.`,
      ),
    }
  for (const rule of matches)
    if (rule.evidenceContract) {
      const verdict = evidence(rule.evidenceContract)
      if (verdict.state !== 'verified')
        return {
          effect: 'deny',
          requestHash,
          ruleIds,
          reason: refusal(
            'missing_evidence',
            'EVIDENCE_REQUIRED',
            `Rule ${rule.id} requires verified evidence.`,
            verdict.missing.length ? verdict.missing : ['deterministic evidence or human review'],
          ),
        }
    }
  const effect = matches.some((rule) => rule.effect === 'require_review')
    ? 'require_review'
    : matches.length
      ? 'allow'
      : defaultEffect
  return {
    effect,
    requestHash,
    ruleIds,
    ...(effect === 'deny'
      ? {
          reason: refusal(
            'missing_permissions',
            'NO_MATCHING_PERMISSION',
            'No policy rule admits this action.',
          ),
        }
      : {}),
  }
}
