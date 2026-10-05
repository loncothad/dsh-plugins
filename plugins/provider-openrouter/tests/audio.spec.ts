import { expect, it, vi } from 'vitest'
import { generateAudio } from '../src/audio.ts'
import { parseModelsResponse } from '../src/catalog.ts'

it('discovers dedicated speech separately from chat audio', () => {
  const result = parseModelsResponse({
    data: [
      {
        id: 'vendor/speech',
        architecture: { output_modalities: ['speech'], input_modalities: ['text'] },
      },
      {
        id: 'vendor/chat-audio',
        architecture: { output_modalities: ['audio'], input_modalities: ['text'] },
      },
    ],
  })
  expect(result.media.map((model) => model.protocol)).toEqual(['speech', 'chat'])
})
it('collects bounded binary speech and retains result-owned publication access', async () => {
  const fetch = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }),
  )
  const signal = new AbortController().signal
  const result = await generateAudio(
    {
      endpoint: 'https://openrouter.ai/api/v1/audio/speech',
      apiKey: 'fixture',
      maxBytes: 3,
      fetch,
    },
    {
      protocol: 'speech',
      model: 'vendor/speech',
      output: 'audio',
      prompt: 'hello',
      options: { voice: 'narrator' },
    },
    signal,
  )
  expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({
    input: 'hello',
    voice: 'narrator',
    response_format: 'mp3',
  })
  expect(result.artifacts?.[0]).toMatchObject({ mime: 'audio/mpeg' })
  expect(await result.loadArtifact!('dsh-media:speech-result', 3, signal)).toEqual(
    new Uint8Array([1, 2, 3]),
  )
  await expect(result.loadArtifact!('foreign', 3, signal)).rejects.toThrow('publication limit')
})
it('refuses unenforceable transcription routing before transmitting an asset', async () => {
  const fetch = vi.fn()
  await expect(
    generateAudio(
      {
        endpoint: 'https://openrouter.ai/api/v1/audio/transcriptions',
        apiKey: 'fixture',
        maxBytes: 1024,
        routing: { provider: { order: ['pin'] } },
        fetch,
      },
      {
        protocol: 'transcription',
        model: 'vendor/stt',
        output: 'text',
        prompt: '',
        inputs: [{ kind: 'audio', url: 'data:audio/wav;base64,QQ==' }],
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow('does not enforce')
  expect(fetch).not.toHaveBeenCalled()
})
it('transcribes inline audio through the dedicated JSON protocol', async () => {
  const fetch = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ text: 'hello' })),
  )
  const result = await generateAudio(
    {
      endpoint: 'https://openrouter.ai/api/v1/audio/transcriptions',
      apiKey: 'fixture',
      maxBytes: 1024,
      fetch,
    },
    {
      protocol: 'transcription',
      model: 'vendor/stt',
      output: 'text',
      prompt: '',
      inputs: [{ kind: 'audio', url: 'data:audio/wav;base64,QQ==' }],
    },
    new AbortController().signal,
  )
  expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string).input_audio).toEqual({
    data: 'QQ==',
    format: 'wav',
  })
  expect(result.text).toBe('hello')
})
it('preserves requested verbose transcription timestamps and language metadata', async () => {
  const raw = { text: 'hello', language: 'en', segments: [{ start: 0, end: 1, text: 'hello' }] }
  const result = await generateAudio(
    {
      endpoint: 'https://openrouter.ai/api/v1/audio/transcriptions',
      apiKey: 'fixture',
      maxBytes: 2048,
      fetch: async () => new Response(JSON.stringify(raw)),
    },
    {
      protocol: 'transcription',
      model: 'stt',
      output: 'text',
      prompt: '',
      options: { response_format: 'verbose_json' },
      inputs: [{ kind: 'audio', url: 'data:audio/wav;base64,QQ==' }],
    },
    new AbortController().signal,
  )
  expect(JSON.parse(result.text!)).toEqual(raw)
})
it('validates speech format and transcription controls before dispatch and forwards scoped provider options', async () => {
  const fetch = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    expect(body.provider).toEqual({ options: { groq: { prompt: 'vocabulary' } } })
    expect(body.provider_options).toBeUndefined()
    return new Response(JSON.stringify({ text: 'hello' }))
  })
  const options = {
    endpoint: 'https://openrouter.ai/api/v1/audio/transcriptions',
    apiKey: 'fixture',
    maxBytes: 1024,
    fetch,
  }
  const signal = new AbortController().signal
  await expect(
    generateAudio(
      options,
      {
        protocol: 'speech',
        model: 'tts',
        output: 'audio',
        prompt: 'hello',
        options: { response_format: 'wav' },
      },
      signal,
    ),
  ).rejects.toThrow('Invalid model input')
  expect(fetch).not.toHaveBeenCalled()
  await generateAudio(
    options,
    {
      protocol: 'transcription',
      model: 'stt',
      output: 'text',
      prompt: '',
      inputs: [{ kind: 'audio', url: 'data:audio/wav;base64,QQ==' }],
      options: { provider_options: { groq: { prompt: 'vocabulary' } } },
    },
    signal,
  )
})
