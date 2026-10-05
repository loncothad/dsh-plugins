import type { Context } from '@deepseek-ai/cordis'
import { configurationStatus, registerConfiguration } from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h } from 'react'
export const inject = ['slots', 'locale', 'configForms', 'settingsSchema', 'remote']
export function apply(ctx: Context): void {
  const Status = configurationStatus(ctx, 'secrets')
  function Introduction() {
    return h(
      'section',
      null,
      h(Status),
      h('h3', null, 'References enter configuration; values stay on the host'),
      h(
        'p',
        null,
        'Trusted consumers borrow only their declared references in the verified environment. Credential values never become model tools, prompt content or browser status. /secrets lists scope metadata without fetching values.',
      ),
      h(
        'table',
        { style: { tableLayout: 'fixed', overflowWrap: 'anywhere' } },
        h(
          'tbody',
          null,
          ...[
            [
              '1Password',
              'op://vault/item/field; operator desktop login or DSH_SECRET_ENV_OP_TOKEN.',
            ],
            [
              'Vault KV v2',
              'JSON: mount, path, field. HTTPS address; DSH_SECRET_ENV_VAULT_TOKEN bootstrap.',
            ],
            ['Linux Secret Service', 'JSON lookup attributes; environment is added and checked.'],
            [
              'Windows SecretManagement',
              'JSON: vault, name. Get-Secret runs through a fixed PowerShell script.',
            ],
          ].map(([label, detail]) =>
            h('tr', { key: label }, h('th', { scope: 'row' }, label), h('td', null, detail)),
          ),
        ),
      ),
      h(
        'p',
        null,
        'Linux and Windows only. Sign in to third-party providers on the host; this plugin does not ask the model to handle login tokens.',
      ),
    )
  }
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-secrets-broker',
    rowId: 'secrets-broker',
    before: Introduction,
  })
}
