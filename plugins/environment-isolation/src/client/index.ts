import type { Context } from '@deepseek-ai/cordis'
import { configurationStatus, registerConfiguration } from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h } from 'react'
export const inject = ['slots', 'locale', 'configForms', 'settingsSchema', 'remote']
export function apply(ctx: Context): void {
  const Status = configurationStatus(ctx, 'environment')
  function Introduction() {
    return h(
      'section',
      null,
      h(Status),
      h('h3', null, 'Independent deployments'),
      h(
        'p',
        null,
        'Start each DSH host with its own ROOT/dev, ROOT/staging or ROOT/prod DSH_HOME. Credentials, profile settings, data and prompt configuration stay in that home. Selecting another environment here blocks execution until you restart in its matching home; it never reuses another deployment’s credentials.',
      ),
      h(
        'p',
        null,
        'Defaults → environment overrides → user/profile overrides → admitted per-run limits. Arrays and objects replace whole fields. /environment status shows values and provenance. /environment prepare ENV creates an empty private home; /environment limit KEY VALUE lowers this session’s numeric limits.',
      ),
      h(
        'p',
        null,
        'Generic shell access is disabled by default. If enabled, configure OS sandboxing and Policy Engine rules; deployment names alone do not isolate an unrestricted shell.',
      ),
    )
  }
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-environment-isolation',
    rowId: 'environment-isolation',
    before: Introduction,
  })
}
