import type { Context } from '@deepseek-ai/cordis'
import { configurationModel, registerConfiguration } from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h } from 'react'
export const inject = ['slots', 'locale', 'configForms', 'settingsSchema', 'remote']
export function apply(ctx: Context): void {
  const Model = configurationModel(ctx, {
    providerField: 'registeredProvider',
    modelField: 'registeredModel',
    title: 'Text model for decisions',
    description:
      'Any registered text model can choose from named answers. Numeric confidence is not requested or fabricated.',
  })
  function Intro() {
    return h(
      'p',
      null,
      'Native APIs accept named choice, score and yes/no questions. Use /decision Question :: choice | choice :: context, or pass a JSON {state, questions} request. Model probabilities describe the answer, not permission or verification. Conversation Summaries can use this backend for automatic delivery decisions.',
    )
  }
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-llm-decision-models',
    rowId: 'llm-decision-models',
    before: Intro,
    sections: [{ fields: ['registeredProvider', 'registeredModel'], component: Model }],
    groups: [
      {
        title: 'Execution',
        description: 'Select the backend and enable its consumers.',
        fields: ['enabled', 'backend', 'toolsEnabled', 'commandsEnabled', 'skillEnabled'],
      },
      {
        title: 'OpenRouter Decisions',
        description:
          'Uses credentials from Plugins > OpenRouter. Native Decisions API; chat privacy or upstream filters that the endpoint cannot honor block dispatch.',
        fields: ['openrouterModel'],
      },
      {
        title: 'Cloudflare Workers AI',
        description:
          'Requires the Cloudflare Decisions plugin. Credentials and vision limits belong there. Choose its configured default, Clef or Clef Flash.',
        fields: ['cloudflareModel'],
      },
      {
        title: 'TypeSafe',
        description: 'Calls the native System One API with typed questions.',
        fields: ['typesafeApiKey', 'typesafeEndpoint', 'typesafeModel'],
      },
    ],
  })
}
