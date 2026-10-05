import type { Context } from '@deepseek-ai/cordis'
import { authenticationControls, registerConfiguration } from '@loncothad/dsh-plugin-runtime/client'
export const inject = ['slots', 'locale', 'configForms', 'settingsSchema', 'remote']
export function apply(ctx: Context): void {
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-provider-zai',
    rowId: 'provider-zai',
    before: authenticationControls(ctx, 'zaiAuth'),
  })
}
