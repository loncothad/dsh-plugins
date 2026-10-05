import { expect, it } from 'vitest'
import { FalGenerator } from '../src/generator.ts'

it('refuses response-selected foreign origins and userinfo before forwarding the provider key', async () => {
  for (const target of [
    'https://attacker.example/result',
    'https://user:password@queue.fal.run/result',
    'http://queue.fal.run/result',
    'https://queue.fal.run/requests/job#fragment',
  ]) {
    const calls: { url: string; init?: RequestInit }[] = []
    const generator = new FalGenerator({
      apiKey: () => 'fixture-secret',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init })
        return new Response(
          JSON.stringify({
            request_id: 'job',
            status_url: 'https://queue.fal.run/requests/job/status',
            response_url: target,
          }),
        )
      },
    })
    await expect(
      generator.generate({ output: 'video', model: 'fal-ai/video', prompt: 'p' }),
    ).rejects.toThrow('configured origin')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init?.redirect).toBe('error')
  }
})

it('disables redirects on every authenticated queue request', async () => {
  const redirects: (RequestRedirect | undefined)[] = []
  const generator = new FalGenerator({
    apiKey: () => 'fixture-secret',
    fetch: async (_url, init) => {
      redirects.push(init?.redirect)
      return new Response(
        JSON.stringify(
          redirects.length === 1
            ? {
                request_id: 'job',
                status_url: 'https://queue.fal.run/requests/job/status',
                response_url: 'https://queue.fal.run/requests/job',
              }
            : redirects.length === 2
              ? { status: 'COMPLETED' }
              : { video_url: 'https://cdn.example/result.mp4' },
        ),
      )
    },
  })
  await generator.generate({ output: 'video', model: 'fal-ai/video', prompt: 'p' })
  expect(redirects).toEqual(['error', 'error', 'error'])
})

it('selects queue execution from explicit output metadata rather than model-name guesses', async () => {
  const urls: string[] = []
  const generator = new FalGenerator({
    apiKey: () => 'fixture-key',
    fetch: async (url) => {
      urls.push(String(url))
      return new Response(
        JSON.stringify(
          urls.length === 1
            ? {
                request_id: 'job',
                status_url: 'https://queue.fal.run/requests/job/status',
                response_url: 'https://queue.fal.run/requests/job',
              }
            : urls.length === 2
              ? { status: 'COMPLETED' }
              : { video_url: 'https://cdn.example/result.mp4' },
        ),
      )
    },
  })
  await generator.generate({ model: 'vendor/neutral-name', output: 'video', prompt: 'p' })
  expect(urls[0]).toBe('https://queue.fal.run/vendor/neutral-name')
})

it('cancels queue polling sleep promptly without sending another status request', async () => {
  const abort = new AbortController()
  let calls = 0
  const generator = new FalGenerator({
    apiKey: () => 'fixture-secret',
    pollMs: 60_000,
    fetch: async () => {
      if (++calls === 1)
        return new Response(
          JSON.stringify({
            request_id: 'job',
            status_url: 'https://queue.fal.run/requests/job/status',
            response_url: 'https://queue.fal.run/requests/job',
          }),
        )
      setTimeout(() => abort.abort(new Error('cancelled')), 0)
      return new Response(JSON.stringify({ status: 'IN_PROGRESS' }))
    },
  })
  await expect(
    generator.generate({ output: 'video', model: 'fal-ai/video', prompt: 'p' }, abort.signal),
  ).rejects.toThrow('cancelled')
  expect(calls).toBe(2)
})

it('does not expose reflected validation headers or provider keys in a public error', async () => {
  const generator = new FalGenerator({
    apiKey: () => 'fixture-secret',
    fetch: async () =>
      new Response(JSON.stringify({ detail: { authorization: 'Key fixture-secret' } }), {
        status: 422,
      }),
  })
  await expect(
    generator.generate({ output: 'image', model: 'fal-ai/image', prompt: 'p' }),
  ).rejects.toMatchObject({ code: 'CLIENT', status: 422 })
  try {
    await generator.generate({ output: 'image', model: 'fal-ai/image', prompt: 'p' })
  } catch (error) {
    expect(String(error)).not.toContain('fixture-secret')
  }
})

it('cancels the accepted provider job when the caller aborts polling', async () => {
  const controller = new AbortController(),
    calls: { url: string; method?: string }[] = []
  const generator = new FalGenerator({
    apiKey: () => 'fixture',
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method })
      if (calls.length === 1)
        return new Response(
          JSON.stringify({
            request_id: 'job',
            status_url: 'https://queue.fal.run/requests/job/status',
            response_url: 'https://queue.fal.run/requests/job',
            cancel_url: 'https://queue.fal.run/requests/job/cancel',
          }),
        )
      if (calls.length === 2) {
        controller.abort(new Error('cancelled'))
        return new Response(JSON.stringify({ status: 'IN_PROGRESS' }))
      }
      return new Response('{}')
    },
  })
  await expect(
    generator.generate({ model: 'vendor/model', output: 'video', prompt: 'p' }, controller.signal),
  ).rejects.toThrow('cancelled')
  expect(calls.at(-1)).toEqual({ url: 'https://queue.fal.run/requests/job/cancel', method: 'PUT' })
})
it('does not poll, collect or cancel a different request on the same authenticated origin', async () => {
  let calls = 0
  const generator = new FalGenerator({
    apiKey: () => 'fixture',
    fetch: async () => {
      calls++
      return new Response(
        JSON.stringify({
          request_id: 'owned',
          status_url: 'https://queue.fal.run/fal-ai/model/requests/other/status',
          response_url: 'https://queue.fal.run/fal-ai/model/requests/owned',
          cancel_url: 'https://queue.fal.run/fal-ai/model/requests/other/cancel',
        }),
      )
    },
  })
  await expect(
    generator.generate({ model: 'fal-ai/model', output: 'video', prompt: 'p' }),
  ).rejects.toThrow('accepted request scope')
  expect(calls).toBe(1)
})
