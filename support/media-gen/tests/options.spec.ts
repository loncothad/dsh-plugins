import { expect, it } from 'vitest'
import { mergeMediaOptions, modelDefaults } from '../src/options.ts'

it('accepts nested JSON defaults and isolates per-call option snapshots', () => {
  const defaults = modelDefaults({ 'video/model': { duration: 4, audio: { voice: 'alloy' } } })
  const options = mergeMediaOptions(defaults['video/model'], { duration: 8 })!
  expect(options).toEqual({ duration: 8, audio: { voice: 'alloy' } })
  Reflect.set(options.audio as object, 'voice', 'changed')
  expect(defaults['video/model']?.audio).toEqual({ voice: 'alloy' })
})
it('rejects route/input defaults, non-JSON values and oversized defaults', () => {
  expect(() => modelDefaults({ m: { prompt: 'replace the user' } })).toThrow('cannot override')
  expect(() => modelDefaults({ m: { seed: Infinity } })).toThrow('finite JSON')
  expect(() => modelDefaults({ m: { seed: undefined } })).toThrow('finite JSON')
  expect(() => modelDefaults({ m: { caption: 'x'.repeat(32769) } })).toThrow('32 KiB')
  expect(() => mergeMediaOptions({}, { seed: () => 1 })).toThrow('finite JSON')
  expect(() => modelDefaults({ m: [] })).toThrow('Invalid')
})
