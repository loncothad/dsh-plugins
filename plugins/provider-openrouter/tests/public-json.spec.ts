import { expect, it } from 'vitest'
import { publicJson } from '../src/public-json.ts'

it('cancels oversized advertised and streamed public metadata before decoding', async () => {
  for (const advertised of [true, false]) {
    const headers = new Headers()
    if (advertised) headers.set('content-length', '100')
    let cancelled = false
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('123456789'))
        },
        cancel() {
          cancelled = true
        },
      }),
      { headers },
    )
    await expect(publicJson(response, new AbortController().signal, 8)).rejects.toThrow(
      'byte limit',
    )
    expect(cancelled).toBe(true)
  }
})
it('settles a blocked metadata stream on cancellation and preserves valid Unicode', async () => {
  expect(
    await publicJson(new Response('{"name":"İstanbul 🌍"}'), new AbortController().signal),
  ).toEqual({ name: 'İstanbul 🌍' })
  const controller = new AbortController(),
    pending = publicJson(new Response(new ReadableStream()), controller.signal)
  controller.abort(new Error('metadata disposed'))
  await expect(pending).rejects.toThrow('metadata disposed')
})
