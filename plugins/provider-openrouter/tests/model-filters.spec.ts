import { expect, it } from 'vitest'
import { matchesModelFilters } from '../src/model-filters.ts'

it('applies optional price, context, age and vendor filters, preserving explicit unknown behavior', () => {
  const now = Date.UTC(2026, 9, 4),
    data = { inputPrice: 0, outputPrice: 0.5, contextWindow: 128000, listedAt: now - 86400000 }
  const config = {
    modelFiltersEnabled: true,
    maxInputPrice: 0,
    maxOutputPrice: 1,
    minContextWindow: 64000,
    maxCatalogAgeDays: 7,
    modelVendors: ['lab'],
  }
  expect(matchesModelFilters('lab/model', data, config, now)).toBe(true)
  expect(matchesModelFilters('other/model', data, config, now)).toBe(false)
  expect(matchesModelFilters('lab/expensive', { ...data, inputPrice: 0.1 }, config, now)).toBe(
    false,
  )
  expect(
    matchesModelFilters('lab/old', { ...data, listedAt: now - 8 * 86400000 }, config, now),
  ).toBe(false)
  expect(matchesModelFilters('lab/unknown', {}, config, now)).toBe(false)
  expect(
    matchesModelFilters('lab/unknown', {}, { ...config, includeUnknownModelMetadata: true }, now),
  ).toBe(true)
  expect(
    matchesModelFilters('other/unknown', {}, { ...config, modelFiltersEnabled: false }, now),
  ).toBe(true)
})
