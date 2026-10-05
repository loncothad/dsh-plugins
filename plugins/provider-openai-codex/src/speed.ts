/**
 * The processing-speed vocabulary: the selectable names and their
 * backend service tiers, layered onto Codex requests as `service_tier`.
 * Pure domain — the adapter filters tiers per model.
 *
 * @module @loncothad/dsh-provider-openai-codex/speed
 */

/** The selectable processing speeds and their backend service tiers. */
export const SPEED_TIERS = {
  standard: undefined,
  fast: 'priority',
  ultrafast: 'ultrafast',
} as const

/** One selectable speed name. */
export type SpeedName = keyof typeof SPEED_TIERS

/** Every selectable speed name. */
export const SPEED_NAMES = Object.keys(SPEED_TIERS) as readonly SpeedName[]

/** Read/write access to the current speed selection. */
export interface SpeedAccess {
  speed(): SpeedName
  setSpeed(next: SpeedName): void
}

/** One selectable speed name, defaulting to standard. */
export function normalizeSpeed(value: string | undefined): SpeedName {
  return (SPEED_NAMES as readonly string[]).includes(value ?? '')
    ? (value as SpeedName)
    : 'standard'
}
