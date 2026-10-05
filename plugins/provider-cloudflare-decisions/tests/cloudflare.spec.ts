import { expect, it, vi } from 'vitest'
import { validateImages } from '../src/images.ts'
import { requestCloudflare } from '../src/index.ts'

const image = Buffer.alloc(24)
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image)
image.writeUInt32BE(1, 16)
image.writeUInt32BE(1, 20)
const input = {
  state: { ticket: 'outage' },
  questions: {
    urgent: {
      type: 'noul' as const,
      instructions: { question: 'Urgent?', rule: 'Outages are urgent' },
      criteria: { true: 'urgent', false: 'normal' },
    },
  },
  images: [`data:image/png;base64,${image.toString('base64')}`],
}
it('sends the public Clef multimodal contract to the exact account/model endpoint', async () => {
  const transport = vi.fn(async () =>
    Response.json({
      success: true,
      result: {
        model: 'clef-flash',
        answers: { urgent: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 42 },
      },
    }),
  ) as unknown as typeof fetch
  const result = await requestCloudflare(
    {
      accountId: 'a'.repeat(32),
      token: 'private',
      model: 'clef-flash',
      visionEnabled: true,
      fetch: transport,
    },
    input,
    AbortSignal.timeout(5000),
  )
  expect(vi.mocked(transport).mock.calls[0]?.[0]).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/run/@cf/cloudflare/clef-flash`,
  )
  expect(result).toMatchObject({ status: 'unverified', answers: { urgent: { noul: 0.9 } } })
})
it('rejects remote URLs, excessive pixels and disabled vision before dispatch', async () => {
  expect(() => validateImages(['https://example.test/private.png'])).toThrow('embedded')
  const large = Buffer.from(image)
  large.writeUInt32BE(10000, 16)
  large.writeUInt32BE(10000, 20)
  expect(() =>
    validateImages([{ content_type: 'image/png', base64: large.toString('base64') }]),
  ).toThrow('megapixels')
  const transport = vi.fn() as unknown as typeof fetch
  await expect(
    requestCloudflare(
      {
        accountId: 'a'.repeat(32),
        token: 'private',
        model: 'clef',
        visionEnabled: false,
        fetch: transport,
      },
      input,
      AbortSignal.timeout(5000),
    ),
  ).rejects.toThrow('disabled')
  expect(transport).not.toHaveBeenCalled()
})
