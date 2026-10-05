import { expect, it } from 'vitest'
import { mediaMime, runMediaGeneration } from '../src/executor.ts'
import { harvestMedia } from '../src/harvest.ts'

it('ignores echoed inputs and metadata while collecting declared outputs', () => {
  const result = harvestMedia({
    images: [{ url: 'https://cdn.example/generated.jpg' }],
    input: { image_url: 'https://private.example/source.png' },
    metadata: { preview: 'https://private.example/metadata.png' },
    text: 'https://private.example/transcript.png',
  })
  expect(result).toEqual([
    { url: 'https://cdn.example/generated.jpg', mime: 'image/jpeg', modality: 'image' },
  ])
  expect(
    harvestMedia(
      {
        input: { image_url: 'https://private.example/source.png' },
        text: 'https://private.example/transcript.png',
      },
      'image',
    ),
  ).toEqual([])
})
it('preserves declared MIME types and recognizes opaque 3D URLs through output fields', () => {
  expect(
    harvestMedia({
      model_mesh: { url: 'https://cdn.example/object/123', content_type: 'model/obj' },
    }),
  ).toEqual([{ url: 'https://cdn.example/object/123', mime: 'model/obj', modality: '3d' }])
  expect(
    harvestMedia({
      output: { files: [{ url: 'https://cdn.example/file/123', mime_type: 'audio/flac' }] },
    }),
  ).toEqual([{ url: 'https://cdn.example/file/123', mime: 'audio/flac', modality: 'audio' }])
  expect(mediaMime('/workspace/picture#one.jpg')).toBe('image/jpeg')
  expect(
    harvestMedia({
      model_mesh: {
        url: 'https://cdn.example/model.glb',
        content_type: 'application/octet-stream',
      },
    }),
  ).toEqual([{ url: 'https://cdn.example/model.glb', mime: 'model/gltf-binary', modality: '3d' }])
})
it('keeps distinct inline outputs that share an identical base64 header', () => {
  const first = Buffer.from(`${'A'.repeat(60)}left`).toString('base64'),
    second = Buffer.from(`${'A'.repeat(60)}right`).toString('base64')
  expect(first.slice(0, 64)).toBe(second.slice(0, 64))
  expect(
    harvestMedia({ images: [{ b64_json: first }, { b64_json: second }, { b64_json: first }] }),
  ).toHaveLength(2)
})
it('follows model-specific named and repeated File output contracts without collecting echoed inputs', () => {
  const file = {
    type: 'object',
    properties: {
      url: { type: 'string' },
      content_type: { type: 'string' },
      file_name: { type: 'string' },
    },
  }
  const schema = {
    type: 'object',
    $defs: { File: file },
    properties: {
      generated: { type: 'array', items: { $ref: '#/$defs/File' } },
      materials: { type: 'object', additionalProperties: { $ref: '#/$defs/File' } },
      input: file,
      metadata: file,
    },
  }
  const result = harvestMedia(
    {
      generated: [{ url: 'https://cdn.example/a.glb', content_type: 'application/octet-stream' }],
      materials: { diffuse: { url: 'https://cdn.example/b.png', content_type: 'image/png' } },
      input: { url: 'https://private.example/input.glb' },
      metadata: { url: 'https://private.example/trace.png' },
    },
    '3d',
    schema,
  )
  expect(result.map((row) => [row.url, row.mime])).toEqual([
    ['https://cdn.example/a.glb', 'model/gltf-binary'],
    ['https://cdn.example/b.png', 'image/png'],
  ])
})
it('rejects excessive parser work and ignores malformed inline encodings', () => {
  expect(() =>
    harvestMedia({
      images: Array.from({ length: 65 }, (_, index) => `https://cdn.example/${index}.png`),
    }),
  ).toThrow('parser limit')
  expect(harvestMedia({ image_url: 'data:image/png,not-base64' })).toEqual([])
})
it('keeps text-only results free of downloads and publication even when they contain media URLs', async () => {
  const text = 'https://private.example/transcribed-photo.png'
  const result = await runMediaGeneration(
    {
      outDir: 'unused',
      generator: {
        async generate() {
          return { files: [], text, raw: { output: text, image_url: text } }
        },
      },
      fetch: async () => {
        throw new Error('unexpected download')
      },
      io: {
        async mkdir() {
          throw new Error('unexpected publication')
        },
        async write() {
          throw new Error('unexpected publication')
        },
      },
    },
    { model: 'transcription', output: 'text', prompt: 'Transcribe' },
  )
  expect(result).toMatchObject({ text, files: [] })
})

it('downloads and publishes only declared outputs with their normalized extension', async () => {
  const downloads: string[] = [],
    writes: string[] = []
  const result = await runMediaGeneration(
    {
      outDir: 'out',
      generator: {
        async generate() {
          return {
            files: [],
            raw: {
              image: { url: 'https://cdn.example/generated.jpg' },
              input: { image_url: 'https://private.example/source.png' },
            },
          }
        },
      },
      fetch: async (url) => {
        downloads.push(String(url))
        return new Response('JPEG fixture')
      },
      io: {
        async mkdir() {},
        async write(path) {
          writes.push(path)
          return { async rollback() {} }
        },
      },
    },
    { model: 'image', output: 'image', prompt: 'Generate' },
  )
  expect(downloads).toEqual(['https://cdn.example/generated.jpg'])
  expect(result.files[0]).toMatchObject({ modality: 'image', mime: 'image/jpeg' })
  expect(writes[0]).toMatch(/\.jpg$/)
})
