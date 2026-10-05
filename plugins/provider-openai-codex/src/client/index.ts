import type { Context } from '@deepseek-ai/cordis'
import { authenticationControls, registerConfiguration } from '@loncothad/dsh-plugin-runtime/client'
export const inject = ['slots', 'locale', 'configForms', 'settingsSchema', 'remote']
export function apply(ctx: Context): void {
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-provider-openai-codex',
    rowId: 'provider-openai-codex',
    before: authenticationControls(ctx, 'codexAuth'),
  })
}
