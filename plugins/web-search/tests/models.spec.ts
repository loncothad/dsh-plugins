import { expect, it } from 'vitest'
import { searchCatalogSchema } from '../src/models-wire.ts'

it('rejects credentials and malformed IDs at the browser catalog boundary', () => {
  expect(searchCatalogSchema.parse({ available: false, reason: 'Sign in', models: [] })).toEqual({
    available: false,
    reason: 'Sign in',
    models: [],
  })
  expect(() =>
    searchCatalogSchema.parse({ available: true, apiKey: 'secret', models: [] }),
  ).toThrow()
  expect(() =>
    searchCatalogSchema.parse({ available: true, models: [{ id: '', name: 'Bad' }] }),
  ).toThrow()
})
