import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

export interface Config {
  dataDir?: string
  installOnEnable: boolean
  presets: string[]
  extractionEnabled: boolean
  extractionProvider?: string
  extractionModel?: string
  extractionFallbackContextWindow?: number
  extractionBudgetUsd: number
  inputUsdPerMillion?: number
  outputUsdPerMillion?: number
  allowUnknownBilling: boolean
  extractionTimeoutMs: number
  outputReserve: number
  safetyTokens: number
  toolResultReserve: number
  fallbackContextWindow?: number
  providerMaxInput?: number
  retrievalTokens: number
  pins: string[]
  archiveEnabled: boolean
  archiveCodec: 'zstd' | 'gzip'
  archiveIntervalMs: number
  maxOpenWorkspaces?: number
  maxActiveSessions?: number
  retentionDays?: number
  retentionMode: 'importance' | 'recency'
}

export const BaseConfig = z.object({
  dataDir: z
    .string()
    .description(
      'Absolute local archive directory. Default: $DSH_HOME/evidence, or ~/.dsh/evidence. Each canonical workspace gets an isolated database.',
    ),
  installOnEnable: z
    .boolean()
    .default(true)
    .description(
      'Replace stock compaction and pruning in the selected agent presets when this plugin is enabled.',
    ),
  presets: z
    .array(z.string())
    .default(['preset-standard', 'preset-ptc'])
    .description(
      'Profile entry IDs of the agent presets to update. Existing agents retain their preset revision until reopened. Disabled evidence ownership uses native basic compaction.',
    ),
  extractionEnabled: z
    .boolean()
    .default(false)
    .description(
      'Allow original evidence to be sent to the configured extraction model. Context compaction and local retrieval also work with this disabled.',
    ),
  extractionProvider: z
    .string()
    .description(
      'Registered provider route for background extraction. Configure its credential in that provider’s Plugins page.',
    ),
  extractionModel: z
    .string()
    .description(
      'Any model in the native DSH catalog. Extraction disables tools and reserves 1,500 output tokens.',
    ),
  extractionFallbackContextWindow: z
    .number()
    .step(1)
    .min(1)
    .description(
      'Explicit extraction-model context window used only when its adapter advertises none. Separate from the main-model fallback; unknown extraction capacity otherwise prevents egress.',
    ),
  extractionBudgetUsd: z
    .number()
    .min(0)
    .default(2)
    .description(
      'Maximum extraction budget per session in USD, including reservations for unknown outcomes.',
    ),
  inputUsdPerMillion: z
    .number()
    .min(0)
    .description(
      'Extraction input price in USD per million tokens. Leave unset only when unknown billing is explicitly allowed.',
    ),
  outputUsdPerMillion: z
    .number()
    .min(0)
    .description('Extraction output price in USD per million tokens.'),
  allowUnknownBilling: z
    .boolean()
    .default(false)
    .description(
      'Explicitly permit extraction when prices or billed usage are unknown. Diagnostics retain unknown attempts.',
    ),
  extractionTimeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .max(300000)
    .default(60000)
    .description(
      'Background extraction deadline in milliseconds. One transient retry is the maximum.',
    ),
  outputReserve: z
    .number()
    .step(1)
    .min(1)
    .default(4096)
    .description('Output reservation when the selected adapter supplies no generation cap.'),
  safetyTokens: z
    .number()
    .step(1)
    .min(0)
    .default(2048)
    .description('Additional input headroom for estimator error and provider framing.'),
  toolResultReserve: z
    .number()
    .step(1)
    .min(0)
    .default(8192)
    .description('Reserved space for the next tool result before admitting a main-model request.'),
  fallbackContextWindow: z
    .number()
    .step(1)
    .min(1)
    .description(
      'Operator-specified context window used only when the adapter advertises none. Unknown capacity otherwise fails explicitly.',
    ),
  providerMaxInput: z
    .number()
    .step(1)
    .min(1)
    .description(
      'Optional stricter provider input-token ceiling, before safety and tool-result reserves.',
    ),
  retrievalTokens: z
    .number()
    .step(1)
    .min(256)
    .max(12000)
    .default(3000)
    .description(
      'Combined readable historical-memory and evidence-retrieval budget; also bounds each retrieval tool result.',
    ),
  pins: z
    .array(z.string())
    .default([])
    .description(
      'Exact operator-pinned instructions. They remain user-level controls and are never inferred from extracted memory.',
    ),
  archiveEnabled: z
    .boolean()
    .default(true)
    .description(
      'Compress eligible cold original objects in a separate worker during idle maintenance.',
    ),
  archiveCodec: z
    .union(['zstd', 'gzip'])
    .default('zstd')
    .description(
      'Lossless cold-storage codec. Zstandard level 3 falls back to gzip when unavailable.',
    ),
  archiveIntervalMs: z
    .number()
    .step(1)
    .min(10000)
    .default(300000)
    .description(
      'Idle archive maintenance interval in milliseconds; foreground storage pressure pauses maintenance.',
    ),
  maxOpenWorkspaces: z
    .number()
    .step(1)
    .min(1)
    .max(64)
    .default(16)
    .description(
      'Maximum workspace databases kept open by this plugin. Active stores are never evicted to admit another workspace; dispose or increase the limit explicitly.',
    ),
  maxActiveSessions: z
    .number()
    .step(1)
    .min(1)
    .max(1024)
    .default(128)
    .description(
      'Maximum active and opening session ledgers. Admission fails explicitly when this capacity is exhausted.',
    ),
  retentionDays: z
    .number()
    .step(1)
    .min(1)
    .description(
      'Optional retention period for complete inactive sessions. Open session ledgers are protected. Default: retain indefinitely. Logical deletion and bounded byte reclamation do not erase the DSH session log.',
    ),
  retentionMode: z
    .union(['importance', 'recency'])
    .default('importance')
    .description(
      'Importance prioritizes corrections, constraints, decisions, failures and file mutations over duplicate reads and successful verbose output. Scores are deterministic retention hints, never confidence or authority. Recency keeps the prior chronological eviction policy. Originals remain archived in either mode.',
    ),
})

export function validateConfig(config: Config): Config & { dataDir: string } {
  for (const key of Object.keys(config))
    if (!Object.hasOwn(BaseConfig.dict!, key))
      throw new Error(`Unknown evidence compactor configuration key: ${key}`)
  const dataDir =
    config.dataDir?.trim() || join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'evidence')
  if (!isAbsolute(dataDir)) throw new Error('The evidence archive directory must be absolute')
  if (
    !config.presets.length ||
    config.presets.length > 128 ||
    new Set(config.presets).size !== config.presets.length
  )
    throw new Error('Choose distinct agent preset entry IDs')
  if (
    config.pins.length > 128 ||
    config.pins.some(
      (text) => !text.trim() || text.length > 16384 || Buffer.byteLength(text, 'utf8') > 32 * 1024,
    )
  )
    throw new Error('Exact pins must be nonempty and bounded')
  if (
    config.extractionEnabled &&
    (!config.extractionProvider?.trim() || !config.extractionModel?.trim())
  )
    throw new Error('Select an extraction provider and model before enabling evidence egress')
  return {
    ...config,
    dataDir,
    extractionProvider: config.extractionProvider?.trim(),
    extractionModel: config.extractionModel?.trim(),
  }
}
