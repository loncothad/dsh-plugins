/**
 * Live model discovery for the ChatGPT Codex backend, ported from the
 * official client's models manager: GET {codex}/models?client_version=v
 * with the signed-in account's tokens, a bounded refresh timeout, a
 * TTL cache, retaining only actual account-scoped catalog observations.
 *
 * Response shape (ModelInfo in the official client): slug, display_name,
 * description, visibility, supported_in_api, priority, context_window,
 * max_context_window, default_reasoning_level,
 * supported_reasoning_levels[], service_tiers[],
 * default_service_tier. Pure domain: no harness imports, no network.
 *
 * @module @loncothad/dsh-provider-openai-codex/discovery
 */

import type {
  CatalogModel,
  CatalogReasoning,
  CatalogReasoningEffort,
} from '@loncothad/dsh-llm-openai-compat'

/** The Codex backend's model-list endpoint. */
export const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'

/** Cache lifetime for a fetched catalog (the official client's TTL). */
export const CODEX_MODELS_TTL_MS = 300_000

/** Refresh deadline (the official client's MODELS_REFRESH_TIMEOUT). */
export const CODEX_MODELS_TIMEOUT_MS = 5_000

/** Qualified Codex catalog contract; independent of this plugin's release version. */
export const CODEX_CATALOG_PROTOCOL_VERSION = '0.160.0'

/** `flex` is an API request option even when the catalog does not advertise it. */
export const CODEX_TIER_FLEX = 'flex'

/** The request/config sentinel meaning "no service tier" (standard routing). */
export const CODEX_TIER_DEFAULT = 'default'

/** The cyber access programs the backend can advertise (official wire values). */
export const CODEX_CYBER_PROGRAMS = ['standard', 'daybreak_blue', 'daybreak_red'] as const

/** One cyber access program wire value. */
export type CyberProgram = (typeof CODEX_CYBER_PROGRAMS)[number]

/** Whether one program is a Daybreak tier (the verification-gated cyber programs). */
export function isDaybreakProgram(program: string): boolean {
  return program === 'daybreak_blue' || program === 'daybreak_red'
}

/** One raw entry of the backend's `models[]` array. */
export interface RawModelInfo {
  readonly slug?: unknown
  readonly display_name?: unknown
  readonly description?: unknown
  readonly visibility?: unknown
  readonly supported_in_api?: unknown
  readonly priority?: unknown
  readonly context_window?: unknown
  readonly max_context_window?: unknown
  readonly default_reasoning_level?: unknown
  readonly supported_reasoning_levels?: unknown
  readonly service_tiers?: unknown
  readonly additional_speed_tiers?: unknown
  readonly model_specialty?: unknown
  readonly available_access_programs?: unknown
}

/** The fetched catalog outcome. */
export interface DiscoveredCatalog {
  readonly models: readonly CatalogModel[]
}

/** Build the model-list request URL for the codex backend. */
export function modelsUrl(
  endpoint: string = CODEX_MODELS_URL,
  protocolVersion = CODEX_CATALOG_PROTOCOL_VERSION,
): string {
  if (!/^\d+\.\d+\.\d+$/.test(protocolVersion))
    throw new Error('The Codex catalog protocol version must be a numeric semantic version')
  return `${endpoint.replace(/\/$/, '')}?client_version=${encodeURIComponent(protocolVersion)}`
}

/**
 * Parse the backend's models response into a harness catalog.
 *
 * Follows the official client's catalog rules: slugs must be unique and
 * non-empty (the whole catalog is rejected otherwise, mirroring the
 * official error). ChatGPT-only models remain available to subscription authentication. Only
 * `visibility: "list"` models are pickable (`show_in_picker` in the
 * official client; `hide` and `none` stay out). Context windows use the
 * advertised default `context_window`; a configurable maximum does not
 * authorize a larger default request. Display names, per-model reasoning efforts
 * (`supported_reasoning_levels`, `minimal`…`max`), and per-model service
 * tiers ride along for selectors and per-request tier filtering. Models
 * sort by the backend's `priority` (lowest first), stable within a tie.
 */
export function parseModelsResponse(payload: unknown): DiscoveredCatalog {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('the models response was not an object')
  }
  const record = payload as Record<string, unknown>
  const raw = record.models
  if (!Array.isArray(raw)) {
    throw new Error('the models response omitted its models array')
  }
  const models: CatalogModel[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const info: RawModelInfo =
      typeof entry === 'object' && entry !== null ? (entry as RawModelInfo) : {}
    const slug = info.slug
    if (typeof slug !== 'string' || slug.trim().length === 0) {
      // The official client rejects the whole catalog on any bad slug.
      throw new Error('model catalog must contain unique, non-empty model slugs')
    }
    if (seen.has(slug)) {
      throw new Error('model catalog must contain unique, non-empty model slugs')
    }
    seen.add(slug)
    if (typeof info.visibility === 'string' && info.visibility.toLowerCase() !== 'list') continue
    const window = positiveInt(info.context_window)
    models.push({
      id: slug,
      ...(window !== undefined ? { contextWindow: window } : {}),
      ...displayName(info),
      ...descriptionOf(info),
      ...reasoningOf(info),
      ...serviceTiersOf(info),
      ...cyberProgramsOf(info),
      ...(positiveInt(info.priority) !== undefined ? { priority: positiveInt(info.priority) } : {}),
    })
  }
  return { models: sortByPriority(models) }
}

/**
 * Cyber access programs the model advertises (`available_access_programs.
 * cyber`), mirroring the official client: only known program values are
 * kept — unknown server-side programs must not break catalog loading.
 * Discovery metadata does not grant access; inference still enforces
 * authorization.
 */
function cyberProgramsOf(info: RawModelInfo): { cyberPrograms?: readonly string[] } {
  const programs = info.available_access_programs
  if (typeof programs !== 'object' || programs === null) return {}
  const cyber = (programs as Record<string, unknown>).cyber
  if (!Array.isArray(cyber)) return {}
  const known = cyber.filter(
    (program): program is string =>
      typeof program === 'string' && (CODEX_CYBER_PROGRAMS as readonly string[]).includes(program),
  )
  return known.length > 0 ? { cyberPrograms: known } : {}
}

/** Stable ascending sort by the backend's picker priority. */
function sortByPriority(models: readonly CatalogModel[]): CatalogModel[] {
  return [...models]
    .map((model, index) => ({ model, index }))
    .sort((left, right) => {
      const gap = (left.model.priority ?? 0) - (right.model.priority ?? 0)
      return gap !== 0 ? gap : left.index - right.index
    })
    .map((entry) => entry.model)
}

/** Display name from the current backend contract. */
function displayName(info: RawModelInfo): { name?: string } {
  const name = nonEmpty(info.display_name)
  return name !== undefined ? { name } : {}
}

function descriptionOf(info: RawModelInfo): { description?: string } {
  const description = nonEmpty(info.description)
  return description !== undefined ? { description } : {}
}

/**
 * Reasoning capabilities from `supported_reasoning_levels`
 * (`[{ effort, description }]` with wire-value effort ids) plus the
 * model's `default_reasoning_level`.
 */
function reasoningOf(info: RawModelInfo): { reasoning?: CatalogReasoning } {
  const rawLevels = info.supported_reasoning_levels
  const efforts: CatalogReasoningEffort[] = []
  if (Array.isArray(rawLevels)) {
    for (const level of rawLevels) {
      const id =
        typeof level === 'object' && level !== null
          ? nonEmpty((level as Record<string, unknown>).effort)
          : nonEmpty(level)
      if (id === undefined) continue
      const described =
        typeof level === 'object' && level !== null
          ? nonEmpty((level as Record<string, unknown>).description)
          : undefined
      efforts.push({
        id,
        name: effortName(id),
        ...(described !== undefined ? { description: described } : {}),
      })
    }
  }
  const defaultEffort = nonEmpty(info.default_reasoning_level)
  if (efforts.length === 0 && defaultEffort === undefined) return {}
  return {
    reasoning: {
      efforts:
        efforts.length > 0
          ? efforts
          : defaultEffort !== undefined
            ? [{ id: defaultEffort, name: effortName(defaultEffort) }]
            : [],
      ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    },
  }
}

/** Human label for one wire effort value (`xhigh` -> `Extra High`). */
function effortName(id: string): string {
  return id
    .split(/[-_\s]+/)
    .map((part) => (part === 'xhigh' ? 'Extra High' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
}

/** Service-tier ids the model advertises (`priority`, `ultrafast`, …). */
function serviceTiersOf(info: RawModelInfo): { serviceTiers?: readonly string[] } {
  const ids: string[] = []
  if (Array.isArray(info.service_tiers)) {
    for (const tier of info.service_tiers) {
      const id =
        typeof tier === 'object' && tier !== null
          ? nonEmpty((tier as Record<string, unknown>).id)
          : nonEmpty(tier)
      if (id !== undefined) ids.push(id)
    }
  }
  return ids.length > 0 ? { serviceTiers: ids } : {}
}

/**
 * Whether one model accepts a service tier on a request, mirroring the
 * official client's `supports_service_tier`: `flex` is always an API
 * request option; every other tier must be advertised by the catalog.
 */
export function supportsServiceTier(model: CatalogModel | undefined, tier: string): boolean {
  if (tier === CODEX_TIER_FLEX) return true
  return model?.serviceTiers?.includes(tier) === true
}

/**
 * The `service_tier` value one request should carry, mirroring the
 * official client's `service_tier_for_request`: the `default` sentinel
 * and unadvertised tiers resolve to undefined (omitted from the body).
 */
export function serviceTierForRequest(
  model: CatalogModel | undefined,
  requested: string | undefined,
): string | undefined {
  if (requested === undefined || requested === CODEX_TIER_DEFAULT) return undefined
  return supportsServiceTier(model, requested) ? requested : undefined
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** One cached catalog with its fetch time and revalidation etag. */
export interface CatalogCache {
  models: readonly CatalogModel[]
  fetchedAt: number
  etag?: string
}

/** Whether a cached catalog is still within the TTL window. */
export function cacheFresh(cache: CatalogCache | undefined, now: number): boolean {
  return cache !== undefined && now - cache.fetchedAt < CODEX_MODELS_TTL_MS
}
