import z from '@deepseek-ai/schemastery'
import { z as validate } from 'zod'
export const rulesSchema = validate
  .array(
    validate
      .object({
        id: validate.string().min(1).max(128),
        tools: validate.array(validate.string().min(1).max(128)).min(1).max(128),
        environments: validate
          .array(validate.enum(['dev', 'staging', 'prod']))
          .min(1)
          .max(3),
        effect: validate.enum(['allow', 'deny', 'require_review']),
        evidenceContract: validate.string().min(1).max(128).optional(),
      })
      .strict(),
  )
  .max(256)
export const schema = z.object({
  stateDirectory: z
    .string()
    .description('Absolute private action-audit directory, default $DSH_HOME/plugin-state.'),
  mode: z
    .union(['off', 'observe', 'enforce'])
    .default('enforce')
    .description(
      'Enforce applies final denial guards and native approvals. Observe records judgments without granting additional permission. Off removes this policy layer; other native guards remain authoritative.',
    ),
  environment: z
    .union(['dev', 'staging', 'prod'])
    .default('dev')
    .description(
      'Fallback environment only when Environment Isolation is absent. When present, its immutable verified deployment identity is authoritative.',
    ),
  defaultEffect: z
    .union(['allow', 'deny', 'require_review'])
    .default('require_review')
    .description('Outcome when no rule matches. Human review is the conservative default.'),
  honorFullAccess: z
    .boolean()
    .default(true)
    .description(
      'Honor DSH’s native Full Access preset for unmatched default reviews. Explicit review rules, denials, evidence requirements and other native guards still apply. Never alone does not grant Full Access.',
    ),
  rules: z
    .array(
      z.object({
        id: z.string(),
        tools: z.array(z.string()),
        environments: z.array(z.union(['dev', 'staging', 'prod'])),
        effect: z.union(['allow', 'deny', 'require_review']),
        evidenceContract: z.string(),
      }),
    )
    .default([
      {
        id: 'read-and-inspect',
        tools: [
          'read_file',
          'glob',
          'grep',
          'evidence_read',
          'evidence_search',
          'get_sisyphus',
          'get_goal',
          'get_goals',
          'clarify_goal',
          'propose_goal_draft',
          'report_goal_progress',
          'update_goal_task',
          'add_goal_tasks',
          'goal_task',
          'finish_goal',
          'sisyphus_step',
          'request_conversation_summary',
        ],
        environments: ['dev', 'staging', 'prod'],
        effect: 'allow',
      },
    ])
    .description(
      'Ordered JSON rule editor. Deny dominates human review; review dominates allow. Tool names accept * globs. Optional evidenceContract requires a verified contract from Evidence Assurance.',
    ),
  allowWorkspaceInspection: z
    .boolean()
    .default(true)
    .description(
      'Allow literal pwd and ls directory metadata in the current workspace when no explicit rule matches. File reads, substitutions, pipelines and Git helpers do not qualify.',
    ),
  rememberSimilar: z
    .boolean()
    .default(true)
    .description(
      'Offer a human Approve similar choice. Permissions are limited to this chat, workspace, environment and sandbox mode; policy changes invalidate them.',
    ),
  similarApprovalMs: z
    .number()
    .step(1)
    .min(30000)
    .max(86400000)
    .default(3600000)
    .description(
      'Remembered permission lifetime in milliseconds. Permissions remain inspectable and revocable.',
    ),
  approvalTimeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .max(300000)
    .default(120000)
    .description(
      'Deadline for native human approval. Missing approval support, cancellation or timeout denies the action.',
    ),
  skillEnabled: z
    .boolean()
    .default(true)
    .description(
      'Offer structured refusal and output-state guidance through the native skill registry.',
    ),
})
