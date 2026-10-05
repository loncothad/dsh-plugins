import type { Context } from '@deepseek-ai/cordis'
import { registerConfiguration } from '@loncothad/dsh-plugin-runtime/client'
export const inject = ['slots', 'locale', 'configForms', 'settingsSchema', 'remote']
export function apply(ctx: Context) {
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-provider-cloudflare-decisions',
    rowId: 'provider-cloudflare-decisions',
    groups: [
      {
        title: 'Workers AI account',
        description:
          'Requires a Cloudflare token with Workers AI permission. Credentials stay on the host.',
        fields: ['enabled', 'accountId', 'apiToken'],
      },
      {
        title: 'Clef models',
        description:
          'Clef: 27B, $0.24 per million input tokens. Clef Flash: 9B, $0.09 per million input tokens. Both have a 65,536-token context. Prices checked 2026-10-03. Select Cloudflare in Decision Models for commands, tools or summaries.',
        fields: ['model', 'visionEnabled'],
      },
      {
        title: 'Request limits',
        description:
          'Embedded PNG, JPEG and WebP only: four images, 4 MiB and 16 megapixels each, 8 MiB total. Unknown results never grant permission.',
        fields: ['timeoutMs', 'maxConcurrentRequests'],
      },
    ],
  })
}
