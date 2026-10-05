import z from '@deepseek-ai/schemastery'
import { z as validate } from 'zod'
export const layerSchema = validate
  .object({
    allowedTools: validate.array(validate.string().regex(/^[a-zA-Z0-9_.*:-]{1,128}$/)).max(256),
    guidance: validate.string().max(16384),
    maxModelCalls: validate.number().int().min(1).max(10000),
    maxToolCalls: validate.number().int().min(1).max(100000),
    maxOutputCharacters: validate.number().int().min(256).max(1048576),
    timeoutMs: validate.number().int().min(1000).max(3600000),
  })
  .strict()
export type Layer = validate.infer<typeof layerSchema>
export const defaults: Layer = {
  allowedTools: ['*'],
  guidance:
    'Keep work within this environment. Credentials and data from another environment are unavailable.',
  maxModelCalls: 128,
  maxToolCalls: 1024,
  maxOutputCharacters: 262144,
  timeoutMs: 120000,
}
export const schema = z.object({
  environment: z
    .union(['dev', 'staging', 'prod'])
    .default('dev')
    .description(
      'Immutable deployment identity. Run one DSH host/profile home per environment; changing this setting cannot switch a running host into another environment.',
    ),
  rootDirectory: z
    .string()
    .description(
      'Absolute parent containing independent dev, staging and prod DSH_HOME directories. Default: the parent of the configured host home. The current DSH_HOME must equal ROOT/ENVIRONMENT.',
    ),
  allowShell: z
    .boolean()
    .default(false)
    .description(
      'Admit generic shell/terminal capabilities after environment checks. Off prevents arbitrary shell access to sibling deployment data; trusted verifier consumers can still execute their configured checks. Enabling requires an appropriate OS sandbox and Policy Engine rules.',
    ),
  defaults: z
    .dict(z.any())
    .default(defaults)
    .description(
      'Default configuration object: allowedTools, guidance, maxModelCalls, maxToolCalls, maxOutputCharacters and timeoutMs.',
    ),
  environmentOverrides: z
    .dict(z.dict(z.any()))
    .default({
      dev: {},
      staging: {
        allowedTools: ['read_file', 'glob', 'grep', 'evidence_read', 'evidence_search'],
        maxModelCalls: 64,
      },
      prod: { allowedTools: ['read_file', 'evidence_read', 'evidence_search'], maxModelCalls: 32 },
    })
    .description(
      'Environment overrides keyed exactly by dev, staging or prod. They replace whole fields, not partial arrays. Unknown keys fail.',
    ),
  userOverrides: z
    .dict(z.any())
    .default({})
    .description(
      'Profile/user overrides after the environment layer. Empty inherits all preceding values. Per-run overrides may lower only numeric limits.',
    ),
})
