import type { Context } from '@deepseek-ai/cordis'
import { accountStatus, registerConfiguration } from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h } from 'react'
import { searchModels } from './models.ts'
export const inject = ['slots', 'locale', 'configForms', 'settingsSchema', 'remote']
export function apply(ctx: Context): void {
  const CodexAccount = accountStatus(ctx, 'codexAuth')
  function Intro() {
    return h(
      'div',
      null,
      h('h3', null, 'Subscription search'),
      h(CodexAccount),
      h(
        'p',
        null,
        'The codex search provider uses this active account through ChatGPT Codex, including token refresh. Change accounts in that plugin. The openai search provider uses a separate API key and API billing.',
      ),
    )
  }
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-web-search',
    rowId: 'web-search',
    before: Intro,
    sections: [
      { fields: ['codexModel'], component: searchModels(ctx, 'codex', 'codexModel') },
      { fields: ['openaiModel'], component: searchModels(ctx, 'api', 'openaiModel') },
    ],
    groups: [
      {
        title: 'Kagi',
        description: 'Kagi API search. Off by default. Requires your Kagi key.',
        fields: ['kagiEnabled', 'kagiApiKey', 'kagiBaseUrl', 'kagiLimit'],
      },
      {
        title: 'OpenRouter',
        description: 'OpenRouter hosted web search. Off by default. Requires your OpenRouter key.',
        fields: ['openrouterEnabled', 'openrouterApiKey', 'openrouterBaseUrl', 'openrouterModel'],
      },
      {
        title: 'Exa',
        description:
          'Exa REST search with an API key, or its public MCP search when no key is configured.',
        fields: ['exaEnabled', 'exaApiKey', 'exaBaseUrl'],
      },
      {
        title: 'ChatGPT Codex',
        description:
          'Provider ID: codex. Uses the active subscription account shown above. No API-key fallback.',
        fields: ['codexEnabled', 'codexModel'],
      },
      {
        title: 'OpenAI API',
        description:
          'Provider ID: openai. Off by default. Requires an OpenAI API key. Billed separately from ChatGPT.',
        fields: ['openaiEnabled', 'openaiApiKey', 'openaiBaseUrl', 'openaiModel'],
      },
    ],
  })
}
