import { runMediaGeneration } from '@loncothad/dsh-media-gen'
import { expect, it } from 'vitest'
import { OpenRouterMediaGenerator } from '../src/media.ts'
import { generateVideo } from '../src/video.ts'
import { parseVideoModels } from '../src/video-catalog.ts'

it('submits a native video job, polls it, and authenticates only that job’s bounded content download', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const generator = new OpenRouterMediaGenerator({
    apiKey: () => 'fixture-key',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    videoEndpoint: 'https://openrouter.ai/api/v1/videos',
    videoPollMs: 0,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      if (calls.length === 1)
        return new Response(
          JSON.stringify({
            id: 'job-1',
            polling_url: 'https://openrouter.ai/api/v1/videos/job-1',
            status: 'pending',
          }),
          { status: 202 },
        )
      if (calls.length === 2)
        return new Response(
          JSON.stringify({
            id: 'job-1',
            status: 'completed',
            unsigned_urls: ['https://openrouter.ai/api/v1/videos/job-1/content?index=0'],
          }),
        )
      return new Response('VIDEO', { headers: { 'content-type': 'video/mp4' } })
    },
  })
  const writes: Uint8Array[] = []
  const result = await runMediaGeneration(
    {
      generator,
      outDir: 'out',
      io: {
        async mkdir() {},
        async write(_path, data) {
          writes.push(data)
          return { async rollback() {} }
        },
      },
    },
    {
      model: 'vendor/video',
      output: 'video',
      prompt: 'Animate the reference',
      inputs: [{ kind: 'image', url: 'https://cdn.example/image.png' }],
      options: { duration: 4 },
    },
  )
  expect(result.files[0]).toMatchObject({ modality: 'video', mime: 'video/mp4' })
  expect(Buffer.from(writes[0]!).toString()).toBe('VIDEO')
  const body = JSON.parse(calls[0]!.init!.body as string)
  expect(body).toMatchObject({
    model: 'vendor/video',
    duration: 4,
    input_references: [{ type: 'image_url', image_url: { url: 'https://cdn.example/image.png' } }],
  })
  expect(calls).toHaveLength(3)
  for (const call of calls) {
    expect(new Headers(call.init?.headers).get('authorization')).toBe('Bearer fixture-key')
    expect(call.init?.redirect).toBe('error')
  }
})

it('refuses foreign polling/content URLs and sibling jobs without forwarding the credential', async () => {
  for (const target of [
    'https://attacker.example/job-1',
    'https://user:pass@openrouter.ai/api/v1/videos/job-1',
    'https://openrouter.ai/api/v1/videos/other-job',
  ]) {
    let calls = 0
    const generator = new OpenRouterMediaGenerator({
      apiKey: () => 'fixture-key',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      videoEndpoint: 'https://openrouter.ai/api/v1/videos',
      fetch: async () => {
        calls++
        return new Response(JSON.stringify({ id: 'job-1', status: 'pending', polling_url: target }))
      },
    })
    await expect(
      generator.generate({ model: 'video', output: 'video', prompt: 'p' }),
    ).rejects.toThrow('scope')
    expect(calls).toBe(1)
  }
})

it('bounds protected content and rejects arbitrary uses of a result-owned download capability', async () => {
  let calls = 0
  const generator = new OpenRouterMediaGenerator({
    apiKey: () => 'fixture-key',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    videoEndpoint: 'https://openrouter.ai/api/v1/videos',
    fetch: async () => {
      if (++calls === 1)
        return new Response(
          JSON.stringify({
            id: 'j',
            status: 'completed',
            polling_url: 'https://openrouter.ai/api/v1/videos/j',
            unsigned_urls: ['https://openrouter.ai/api/v1/videos/j/content'],
          }),
        )
      return new Response('OVERSIZED')
    },
  })
  const result = await generator.generate({ model: 'video', output: 'video', prompt: 'p' })
  await expect(
    result.loadArtifact!('https://openrouter.ai/api/v1/keys', 1024, new AbortController().signal),
  ).rejects.toThrow('belong')
  expect(calls).toBe(1)
  await expect(
    result.loadArtifact!(result.artifacts![0]!.url, 2, new AbortController().signal),
  ).rejects.toThrow('byte limit')
})

it('retains video catalog capability limits and rejects malformed chat-shaped entries', () => {
  const models = parseVideoModels({
    data: [
      {
        id: 'video/model',
        name: 'Video',
        supported_durations: [4, 8],
        supported_resolutions: ['720p'],
        supported_frame_images: ['first_frame'],
        pricing_skus: { duration_seconds: '0.02' },
        seed: true,
      },
      { id: 'chat/model', architecture: { output_modalities: ['text'] } },
    ],
  })
  expect(models).toHaveLength(1)
  expect(models[0]).toMatchObject({
    outputs: ['video'],
    inputs: ['text', 'image'],
    parameters: {
      duration: { values: [4, 8] },
      resolution: { values: ['720p'] },
      seed: { type: 'number' },
    },
  })
})
it('refuses unsupported routing before submitting a video job', async () => {
  let calls = 0
  await expect(
    generateVideo(
      {
        endpoint: 'https://openrouter.ai/api/v1/videos',
        apiKey: 'fixture',
        body: { provider: { order: ['pin'] } },
        fetch: async () => {
          calls++
          return new Response()
        },
      },
      { model: 'vendor/video', protocol: 'video', output: 'video', prompt: 'p' },
      new AbortController().signal,
    ),
  ).rejects.toThrow('cannot enforce')
  expect(calls).toBe(0)
})

it('reports the submitted identity when waiting is aborted without claiming remote cancellation', async () => {
  const controller = new AbortController()
  const result = generateVideo(
    {
      endpoint: 'https://openrouter.ai/api/v1/videos',
      apiKey: 'fixture',
      fetch: async () => {
        setTimeout(() => controller.abort(), 1)
        return new Response(
          JSON.stringify({
            id: 'retained-job',
            polling_url: 'https://openrouter.ai/api/v1/videos/retained-job',
            status: 'pending',
          }),
        )
      },
    },
    { model: 'video', output: 'video', prompt: 'p' },
    controller.signal,
  )
  await expect(result).rejects.toThrow('video job retained-job')
})
