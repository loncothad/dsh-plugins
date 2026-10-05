import type { Context } from '@deepseek-ai/cordis'
import { mediaModelControls } from '@loncothad/dsh-media-gen/client'
import { registerConfiguration } from '@loncothad/dsh-plugin-runtime/client'
import { providerControls } from './providers.ts'
export const inject = ['slots', 'locale', 'configForms', 'settingsSchema', 'remote']
const mediaFields = [
  { field: 'imageModel', output: 'image', label: 'Image model' },
  { field: 'videoModel', output: 'video', label: 'Video model' },
  { field: 'audioModel', output: 'audio', label: 'Audio model' },
  { field: 'textMediaModel', output: 'text', label: 'Media understanding and other text output' },
] as const
export function apply(ctx: Context): void {
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-provider-openrouter',
    rowId: 'provider-openrouter',
    groups: [
      {
        title: 'Model selector filters',
        description:
          'Optional defaults for the native model list. Prices are USD per million tokens. Dates are OpenRouter listing dates; original release dates are unavailable. Saved hidden models remain usable.',
        fields: [
          'modelFiltersEnabled',
          'maxInputPrice',
          'maxOutputPrice',
          'minContextWindow',
          'maxCatalogAgeDays',
          'modelVendors',
          'includeUnknownModelMetadata',
        ],
      },
    ],
    sections: [
      { fields: ['modelProviders'], component: providerControls(ctx) },
      {
        fields: [...mediaFields.map((item) => item.field), 'mediaModelOptions'],
        standardFields: ['mediaModelOptions'],
        component: mediaModelControls(ctx, 'openrouterMediaCatalog', mediaFields),
      },
    ],
  })
}
