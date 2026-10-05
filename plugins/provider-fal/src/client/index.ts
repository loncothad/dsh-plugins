import type { Context } from '@deepseek-ai/cordis'
import { mediaModelControls } from '@loncothad/dsh-media-gen/client'
import { registerConfiguration } from '@loncothad/dsh-plugin-runtime/client'
export const inject = ['slots', 'locale', 'configForms', 'settingsSchema', 'remote']
const mediaFields = [
  { field: 'imageModel', output: 'image', label: 'Image model' },
  { field: 'videoModel', output: 'video', label: 'Video model' },
  { field: 'audioModel', output: 'audio', label: 'Audio model' },
  { field: 'meshModel', output: '3d', label: '3D model' },
  { field: 'textModel', output: 'text', label: 'Transcription and other text output' },
] as const
export function apply(ctx: Context): void {
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-provider-fal',
    rowId: 'provider-fal',
    sections: [
      {
        fields: [...mediaFields.map((item) => item.field), 'mediaModelOptions'],
        standardFields: ['mediaModelOptions'],
        component: mediaModelControls(ctx, 'falMediaCatalog', mediaFields),
      },
    ],
  })
}
