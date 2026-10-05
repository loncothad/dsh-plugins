import type { Context } from '@deepseek-ai/cordis'
import { configurationStatus, registerConfiguration } from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h } from 'react'
import { permissionControls } from './permissions.ts'
export const inject = ['slots', 'locale', 'configForms', 'settingsSchema', 'remote']
export function apply(ctx: Context): void {
  permissionControls(ctx)
  const Status = configurationStatus(ctx, 'policy')
  function Introduction() {
    return h(
      'section',
      null,
      h(Status),
      h('h3', null, 'Permission belongs to the host'),
      h(
        'p',
        null,
        'Rules run before tool dispatch and again in DSH’s final execution guard. Denials remain effective if another plugin tries to allow the call or if a configuration replacement fails. Human approvals bind the exact arguments, environment and evidence target.',
      ),
      h(
        'p',
        null,
        'Deny overrides review; review overrides allow. Missing evidence cannot be replaced by an approval or a model statement. /policy shows the active policy. Environment Isolation and Evidence Assurance provide stronger context when installed.',
      ),
      h(
        'p',
        null,
        'Honor Full Access lets DSH’s Full Access preset authorize actions covered only by the default review setting. Explicit review rules still require Ask; denials and evidence checks remain enforced.',
      ),
    )
  }
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-policy-engine',
    rowId: 'policy-engine',
    before: Introduction,
  })
}
