import z from '@deepseek-ai/schemastery'
import { z as validate } from 'zod'
export const contractSchema = validate
  .object({
    id: validate.string().min(1).max(128),
    minimumIndependentSources: validate.number().int().min(0).max(128),
    freshnessMs: validate.number().int().min(1000).max(86400000),
    requireDatabaseRead: validate.boolean(),
    verifiers: validate.array(validate.string().min(1).max(128)).max(32),
    requireModelVerifier: validate.boolean(),
    requireHumanReview: validate.boolean(),
  })
  .strict()
export const verifierSchema = validate
  .object({
    id: validate.string().min(1).max(128),
    command: validate.string().min(1).max(4096),
    arguments: validate.array(validate.string().max(16384)).max(64),
    kind: validate.enum(['verification', 'database-read']),
    credentialBindings: validate.record(validate.string(), validate.string()).optional(),
  })
  .strict()
export type Verifier = validate.infer<typeof verifierSchema>
export const schema = z.object({
  stateDirectory: z
    .string()
    .description(
      'Absolute private plugin-state directory outside agent workspaces. Default: $DSH_HOME/plugin-state. Native session logs remain unchanged.',
    ),
  contracts: z
    .array(z.dict(z.any()))
    .default([
      {
        id: 'goal-completion',
        minimumIndependentSources: 0,
        freshnessMs: 300000,
        requireDatabaseRead: false,
        verifiers: [],
        requireModelVerifier: false,
        requireHumanReview: true,
      },
    ])
    .description(
      'Named evidence contracts: id, minimumIndependentSources, freshnessMs, requireDatabaseRead, verifiers, requireModelVerifier and requireHumanReview. Empty evidence conditions remain unverified; model opinion alone never certifies action.',
    ),
  goalContract: z
    .string()
    .default('goal-completion')
    .description(
      'Contract for model-driven regular and ordered goal completion. Human-review is the default; configure deterministic verifier IDs for consequential work.',
    ),
  verifiers: z
    .array(z.dict(z.any()))
    .default([])
    .description(
      'Trusted verifier recipes: id, absolute command, arguments, kind (verification/database-read), optional credentialBindings mapping ENVVAR to broker reference. No model-supplied code or argument interpolation is executed. Exact {workspace} arguments pass the workspace path as a value.',
    ),
  sourceOrigins: z
    .dict(z.string())
    .default({})
    .description(
      'Explicit HTTPS source-origin to independent publisher-group mapping. Only these origins may be fetched as evidence. Duplicate publisher groups or identical content do not count twice.',
    ),
  modelVerification: z
    .boolean()
    .default(false)
    .description(
      'Enable separate auxiliary model validation. A pass is an opinion and must accompany deterministic evidence or human review.',
    ),
  verifierProvider: z
    .string()
    .default('')
    .description(
      'Registered provider for independent model verification; credentials remain in that provider.',
    ),
  verifierModel: z
    .string()
    .default('')
    .description(
      'Any registered text model. It must differ from the generation model when the restriction below is enabled.',
    ),
  requireDifferentModel: z
    .boolean()
    .default(true)
    .description(
      'Refuse to validate using the same registered provider/model pair as the current generation model.',
    ),
  verifierGuidance: z
    .string()
    .default(
      'Check the stated acceptance criteria against the supplied evidence. Preserve corrections and qualifiers. Failed checks, missing evidence and uncertain results require rejection.',
    )
    .description(
      'Additional validation criteria. Evidence remains untrusted data and cannot grant permissions.',
    ),
  maxModelCalls: z
    .number()
    .step(1)
    .min(1)
    .max(1000)
    .default(32)
    .description(
      'Durable auxiliary verifier-call limit per session, including failed/unknown attempts. Monetary billing is not estimated by this limit.',
    ),
  maxOutputTokens: z
    .number()
    .step(1)
    .min(0)
    .max(8192)
    .default(2048)
    .description(
      'Verifier output token limit. Zero omits an explicit cap for providers such as Codex; character and deadline limits still apply.',
    ),
  timeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .max(300000)
    .default(60000)
    .description('Deadline for source reads, executable verifiers and model validation.'),
  maxOutputBytes: z
    .number()
    .step(1)
    .min(1024)
    .max(1048576)
    .default(65536)
    .description(
      'Aggregate stdout/stderr limit for a verifier. Output is hashed and redacted; model-facing tools return verdict metadata, not raw credentials or command output.',
    ),
  toolsEnabled: z
    .boolean()
    .default(true)
    .description(
      'Expose verification/status tools. Disabling unregisters them and prevents direct execution.',
    ),
  skillEnabled: z
    .boolean()
    .default(true)
    .description(
      'Offer the output-state and evidence-requirement skill through native skill discovery.',
    ),
})
export interface Policy {
  stateDirectory?: string
  contracts: Record<string, unknown>[]
  goalContract: string
  verifiers: Record<string, unknown>[]
  sourceOrigins: Record<string, string>
  modelVerification: boolean
  verifierProvider: string
  verifierModel: string
  requireDifferentModel: boolean
  verifierGuidance: string
  maxModelCalls: number
  maxOutputTokens: number
  timeoutMs: number
  maxOutputBytes: number
  toolsEnabled: boolean
  skillEnabled: boolean
}
