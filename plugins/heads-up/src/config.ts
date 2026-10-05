import s from '@deepseek-ai/schemastery'
export const configSchema = s.object({
  automatic: s
    .boolean()
    .default(true)
    .description(
      'Review settled assistant messages and tool results. Local checks do not call an API.',
    ),
  reviewMain: s.boolean().default(true),
  reviewSubagents: s.boolean().default(true),
  everyEvents: s
    .number()
    .step(1)
    .min(1)
    .max(100)
    .default(8)
    .description(
      'Settled messages/results between reviews while an agent is still running. Turn end also triggers review.',
    ),
  debounceMs: s.number().step(1).min(100).max(60000).default(1000),
  modelEnabled: s
    .boolean()
    .default(false)
    .description(
      'Send bounded evidence to the selected independent reviewer. Off keeps local checks only.',
    ),
  reviewerProvider: s.string().default(''),
  reviewerModel: s.string().default(''),
  reviewerEffort: s.string().default(''),
  requireDifferentModel: s
    .boolean()
    .default(true)
    .description('Reject the generation model as its own reviewer.'),
  reviewerGuidance: s
    .string()
    .pattern(/^[\s\S]{0,8192}$/)
    .default(
      'Look for weakened tests, missing verification, hidden limitations, changed scope, risky retries, stale evidence and contradictions. Flag actionable concerns the user may miss. Do not manufacture concerns.',
    ),
  categories: s
    .array(
      s.union([
        'test_integrity',
        'verification',
        'retry_safety',
        'scope',
        'contradiction',
        'other',
      ]),
    )
    .default(['test_integrity', 'verification', 'retry_safety', 'scope', 'contradiction', 'other']),
  minimumSeverity: s.union(['info', 'warning', 'critical']).default('warning'),
  workspaceDiffs: s
    .boolean()
    .default(false)
    .description(
      'Read a bounded Git diff from an explicitly mapped local workspace. Never execute diff helpers or read secret files. A workspace snapshot does not prove which agent made a change.',
    ),
  includeLatestUserRequest: s
    .boolean()
    .default(false)
    .description(
      'Include the main chat’s latest user request in independent model review. Off avoids sending that extra user text.',
    ),
  includeToolOutputs: s.boolean().default(true),
  maxInputCharacters: s.number().step(1).min(4096).max(131072).default(32768),
  maxEventCharacters: s.number().step(1).min(512).max(16384).default(4096),
  maxWindowsPerReview: s
    .number()
    .step(1)
    .min(1)
    .max(16)
    .default(4)
    .description(
      'Bounded evidence windows per review. Remaining coverage is reported; review again to continue.',
    ),
  maxNotices: s.number().step(1).min(1).max(32).default(16),
  maxOutputTokens: s
    .number()
    .step(1)
    .min(0)
    .max(8192)
    .default(2048)
    .description(
      'Zero lets providers such as Codex omit a token cap; output byte and time limits still apply.',
    ),
  timeoutMs: s.number().step(1).min(1000).max(300000).default(60000),
  maxLiveSources: s
    .number()
    .step(1)
    .min(1)
    .max(16384)
    .default(1024)
    .description(
      'Maximum observed live agents. Capacity exhaustion reports missing observation without preventing agent creation.',
    ),
  maxConcurrentJobs: s.number().step(1).min(1).max(8).default(2),
  maxQueuedJobs: s.number().step(1).min(1).max(128).default(32),
  maxModelCallsPerChat: s.number().step(1).min(1).max(1000).default(20),
  maxBudgetUsd: s
    .number()
    .min(0)
    .max(1000)
    .default(2)
    .description(
      'Per-chat conservative reserved review budget. Unknown outcomes keep their reservation.',
    ),
  inputUsdPerMillion: s.number().min(0),
  outputUsdPerMillion: s.number().min(0),
  allowUnknownBilling: s
    .boolean()
    .default(false)
    .description(
      'Explicitly permit unknown prices. Each such call reserves all remaining budget. Model call limits still apply.',
    ),
  fallbackContextWindow: s.number().step(1).min(0).max(2000000).default(0),
  commandEnabled: s.boolean().default(true),
  skillEnabled: s.boolean().default(false),
  stateDirectory: s
    .string()
    .description('Private state outside agent workspaces. Default: $DSH_HOME/plugin-state.'),
})
export type Policy = ReturnType<typeof resolvePolicy>
export function resolvePolicy(input: Record<string, unknown>) {
  return configSchema(input) as {
    automatic: boolean
    reviewMain: boolean
    reviewSubagents: boolean
    everyEvents: number
    debounceMs: number
    modelEnabled: boolean
    reviewerProvider: string
    reviewerModel: string
    reviewerEffort: string
    requireDifferentModel: boolean
    reviewerGuidance: string
    categories: string[]
    minimumSeverity: 'info' | 'warning' | 'critical'
    workspaceDiffs: boolean
    includeLatestUserRequest: boolean
    includeToolOutputs: boolean
    maxInputCharacters: number
    maxEventCharacters: number
    maxWindowsPerReview: number
    maxNotices: number
    maxOutputTokens: number
    timeoutMs: number
    maxLiveSources: number
    maxConcurrentJobs: number
    maxQueuedJobs: number
    maxModelCallsPerChat: number
    maxBudgetUsd: number
    inputUsdPerMillion?: number
    outputUsdPerMillion?: number
    allowUnknownBilling: boolean
    fallbackContextWindow: number
    commandEnabled: boolean
    skillEnabled: boolean
    stateDirectory?: string
  }
}
