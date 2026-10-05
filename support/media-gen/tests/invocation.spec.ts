import { expect, it } from 'vitest'
import { parseMediaInvocation } from '../src/invocation.ts'

it('preserves quoted filenames, apostrophes and Windows filesystem separators', () => {
  const value = parseMediaInvocation(
    String.raw`@vendor/model don't change the sign --image "C:\pics\new frame.png" --audio '\\server\share\voice clip.wav'`,
  )
  expect(value.error).toBeUndefined()
  expect(value.model).toBe('vendor/model')
  expect(value.prompt).toBe("don't change the sign")
  expect(value.request.inputs).toEqual([
    { kind: 'image', url: String.raw`C:\pics\new frame.png` },
    { kind: 'audio', url: String.raw`\\server\share\voice clip.wav` },
  ])
})
it('parses nested JSON as one options argument followed by more flags or prompt text', () => {
  const value = parseMediaInvocation(
    String.raw`--options {"caption":"a } and \" quote", "nested":{"steps":[1,2]}} --output video animate the boat`,
  )
  expect(value.error).toBeUndefined()
  expect(value.output).toBe('video')
  expect(value.request.options).toEqual({ caption: 'a } and " quote', nested: { steps: [1, 2] } })
  expect(value.prompt).toBe('animate the boat')
})
it('accepts quoted JSON and literal flag-looking prompt text after --', () => {
  const quoted = parseMediaInvocation(
    `paint --options '{"style":"blue sky"}' --image "--source frame.png"`,
  )
  expect(quoted.request.options).toEqual({ style: 'blue sky' })
  expect(quoted.request.inputs?.[0]?.url).toBe('--source frame.png')
  expect(parseMediaInvocation('-- --options {broken text').prompt).toBe('--options {broken text')
  expect(parseMediaInvocation('"--image" is the label').prompt).toBe('--image is the label')
})
it('keeps URL/path prompt text and requires @ for explicit model selection', () => {
  expect(parseMediaInvocation('https://example.com/reference draw this').model).toBeUndefined()
  expect(parseMediaInvocation('folder/reference.png draw this').prompt).toBe(
    'folder/reference.png draw this',
  )
  expect(parseMediaInvocation('@short-model draw this').model).toBe('short-model')
})
it('rejects unterminated quotes, invalid JSON, duplicate singleton flags and unknown options', () => {
  expect(parseMediaInvocation('draw --image "broken.png').error).toContain('Unterminated')
  expect(parseMediaInvocation('draw --options {"x": [1}').error).toContain('--options')
  expect(parseMediaInvocation('draw --output image --output video').error).toContain('only once')
  expect(parseMediaInvocation('draw --options {} --options {}').error).toContain('only once')
  expect(parseMediaInvocation('draw --typo value').error).toContain('Unknown media flag')
  expect(parseMediaInvocation('@ draw').error).toContain('model ID')
})
it('addresses named repeated assets and rejects prototype paths or unbounded asset counts', () => {
  const parsed = parseMediaInvocation(
    'animate --asset {"kind":"image","url":"frame.png","path":["frames",0]} --3d "mesh.glb"',
  )
  expect(parsed.error).toBeUndefined()
  expect(parsed.request.inputs).toEqual([
    { kind: 'image', url: 'frame.png', path: ['frames', 0] },
    { kind: '3d', url: 'mesh.glb' },
  ])
  expect(
    parseMediaInvocation('--asset {"kind":"audio","url":"clip.wav","path":["__proto__"]}').error,
  ).toContain('bounded')
  expect(parseMediaInvocation(Array(9).fill('--image a.png').join(' ')).error).toContain('eight')
})
