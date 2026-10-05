import { runMediaGeneration } from '@loncothad/dsh-media-gen'
import { expect, it } from 'vitest'
import { parseFalModel } from '../src/catalog.ts'
import { FalGenerator } from '../src/generator.ts'

it('catalogs transcription and returns the documented fal output string without writing an artifact', async () => {
  expect(
    parseFalModel(
      {
        endpoint_id: 'fal-ai/speech-to-text',
        metadata: { category: 'speech-to-text', status: 'active', kind: 'inference' },
      },
      0,
    ),
  ).toMatchObject({ outputs: ['text'], inputs: ['audio'] })
  const requests: unknown[] = []
  const generator = new FalGenerator({
    apiKey: () => 'fixture-key',
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init!.body as string))
      return new Response(JSON.stringify({ output: 'This is the transcript.', partial: false }))
    },
  })
  let writes = 0
  const result = await runMediaGeneration(
    {
      generator,
      outDir: 'unused',
      io: {
        async mkdir() {
          throw new Error('no directory publication')
        },
        async write() {
          writes++
          return { async rollback() {} }
        },
      },
    },
    {
      model: 'fal-ai/speech-to-text',
      output: 'text',
      prompt: '',
      inputs: [{ kind: 'audio', url: 'https://cdn.example/recording.mp3' }],
    },
  )
  expect(result.files).toEqual([])
  expect(JSON.parse(result.text!)).toEqual({ output: 'This is the transcript.', partial: false })
  expect(requests[0]).toEqual({ audio_url: 'https://cdn.example/recording.mp3' })
  expect(writes).toBe(0)
})
