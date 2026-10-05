import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { expect, it } from 'vitest'
import { requestView } from '../src/index.ts'
import { viewSchema } from '../src/wire.ts'

it('shows structure without copying image payloads or text by default', () => {
  const view = requestView(
    {
      provider: 'fixture',
      model: 'text',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'private text' },
            {
              type: 'image',
              attachment: {
                attachmentId: AttachmentId('private-image'),
                mediaType: 'image/png',
                bytes: 12,
                width: 1,
                height: 1,
              },
            },
          ],
        },
      ],
    },
    {
      includeTextPreviews: false,
      maxMessages: 128,
      previewCharacters: 1000,
      totalPreviewCharacters: 32768,
      retentionUnits: 128,
    },
  )
  expect(view.messages[0]?.blocks).toEqual(['text', 'image'])
  expect(JSON.stringify(view)).not.toContain('private text')
  expect(JSON.stringify(view)).not.toContain('private-image')
  expect(viewSchema.parse(view)).toEqual(view)
})
it('bounds aggregate previews and reports omitted message rows explicitly', () => {
  const view = requestView(
    {
      provider: 'fixture',
      model: 'text',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'old' }] },
        { role: 'user', content: [{ type: 'text', text: 'key secret' }] },
        { role: 'user', content: [{ type: 'text', text: 'new text' }] },
      ],
    },
    {
      includeTextPreviews: true,
      maxMessages: 2,
      previewCharacters: 8,
      totalPreviewCharacters: 10,
      retentionUnits: 128,
    },
    (text) => text.replace('secret', '[redacted]'),
  )
  expect(view.omittedMessages).toBe(1)
  expect(
    view.messages.reduce((sum, row) => sum + (row.preview?.length ?? 0), 0),
  ).toBeLessThanOrEqual(10)
  expect(view.envelopeHeuristic).toBeGreaterThan(0)
})
