import type { Context } from '@deepseek-ai/cordis'
import { registerConfiguration } from '@loncothad/dsh-plugin-runtime/client'
export const inject = ['slots', 'locale', 'configForms', 'settingsSchema']
export function apply(ctx: Context): void {
  registerConfiguration(ctx, { packageName: '@loncothad/dsh-shell-devenv', rowId: 'shell-devenv' })
}
