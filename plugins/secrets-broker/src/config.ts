import z from '@deepseek-ai/schemastery'
import { z as validate } from 'zod'
export const referencesSchema = validate
  .array(
    validate
      .object({
        id: validate.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/),
        environment: validate.enum(['dev', 'staging', 'prod']),
        provider: validate.enum(['vault', 'onepassword', 'secret-service', 'secretmanagement']),
        locator: validate.string().min(1).max(4096),
        consumers: validate
          .array(validate.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/))
          .min(1)
          .max(64),
      })
      .strict(),
  )
  .max(128)
  .refine(
    (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
    'Secret reference IDs must be unique',
  )
export type SecretReference = validate.infer<typeof referencesSchema>[number]
export const schema = z.object({
  references: z
    .array(
      z.object({
        id: z.string(),
        environment: z.union(['dev', 'staging', 'prod']),
        provider: z.union(['vault', 'onepassword', 'secret-service', 'secretmanagement']),
        locator: z.string(),
        consumers: z.array(z.string()),
      }),
    )
    .default([])
    .description(
      'Scoped reference records: id, environment, provider, locator and allowed consumers. Store references here, never raw secret values. Supported consumers include openrouter, fal, zai and trusted verifier IDs.',
    ),
  leaseMs: z
    .number()
    .step(1)
    .min(1000)
    .max(900000)
    .default(90000)
    .description(
      'Maximum lifetime of one borrowed credential operation. Expiry aborts owned work and rejects late results.',
    ),
  providerTimeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .max(120000)
    .default(30000)
    .description(
      'Deadline for Vault/CLI retrieval. Interactive sign-in belongs to the operator; no model-facing login or raw-secret tool is added.',
    ),
  maxConcurrentLeases: z
    .number()
    .step(1)
    .min(1)
    .max(32)
    .default(8)
    .description('Maximum active credential borrows. Admission fails explicitly when occupied.'),
  maxSecretBytes: z
    .number()
    .step(1)
    .min(1)
    .max(65536)
    .default(16384)
    .description('Maximum UTF-8 secret value size.'),
  maxRedactionValues: z
    .number()
    .step(1)
    .min(1)
    .max(256)
    .default(64)
    .description(
      'Bounded host-memory redaction history. New distinct values are rejected when this capacity is reached; reload deliberately after rotating many secrets.',
    ),
  vaultAddress: z
    .string()
    .default('')
    .description(
      'HTTPS Vault address. Bootstrap tokens use DSH_SECRET_DEV_VAULT_TOKEN, DSH_SECRET_STAGING_VAULT_TOKEN or DSH_SECRET_PROD_VAULT_TOKEN; no cross-environment fallback.',
    ),
  vaultNamespace: z
    .string()
    .default('')
    .description(
      'Optional X-Vault-Namespace. Credentials are sent only to the configured HTTPS Vault origin.',
    ),
  onePasswordExecutable: z
    .string()
    .default('op')
    .description(
      'Trusted 1Password CLI executable. Reads use fixed arguments and secret reference URIs, without a shell.',
    ),
  secretToolExecutable: z
    .string()
    .default('secret-tool')
    .description(
      'Linux Secret Service CLI executable. Locator is a JSON attributes object; environment is enforced as an additional attribute.',
    ),
  powershellExecutable: z
    .string()
    .default('pwsh.exe')
    .description(
      'Windows PowerShell executable with Microsoft.PowerShell.SecretManagement installed. Locator is JSON {"vault":"...","name":"..."}.',
    ),
})
export interface Policy {
  references: SecretReference[]
  leaseMs: number
  providerTimeoutMs: number
  maxConcurrentLeases: number
  maxSecretBytes: number
  maxRedactionValues: number
  vaultAddress: string
  vaultNamespace: string
  onePasswordExecutable: string
  secretToolExecutable: string
  powershellExecutable: string
}
