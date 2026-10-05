export interface ModelFilters {
  modelFiltersEnabled?: boolean
  maxInputPrice?: number
  maxOutputPrice?: number
  minContextWindow?: number
  maxCatalogAgeDays?: number
  modelVendors?: string[]
  includeUnknownModelMetadata?: boolean
}
export interface FilterMetadata {
  inputPrice?: number
  outputPrice?: number
  listedAt?: number
  contextWindow?: number
}
/** Catalog prices are advertised minima, not a guarantee for a pinned endpoint. */
export function matchesModelFilters(
  id: string,
  metadata: FilterMetadata,
  config: ModelFilters,
  now = Date.now(),
): boolean {
  if (!config.modelFiltersEnabled) return true
  if (config.modelVendors?.length && !config.modelVendors.includes(id.split('/')[0]!)) return false
  const checks: [number | undefined, number | undefined, boolean][] = [
    [metadata.inputPrice, config.maxInputPrice, true],
    [metadata.outputPrice, config.maxOutputPrice, true],
    [metadata.contextWindow, config.minContextWindow, false],
    [
      metadata.listedAt,
      config.maxCatalogAgeDays ? now - config.maxCatalogAgeDays * 86400000 : undefined,
      false,
    ],
  ]
  return checks.every(
    ([value, limit, maximum]) =>
      limit === undefined ||
      (value === undefined
        ? config.includeUnknownModelMetadata === true
        : maximum
          ? value <= limit
          : value >= limit),
  )
}
