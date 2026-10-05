import type { Context } from '@deepseek-ai/cordis'
import { editableConfig, managedApply } from '@loncothad/dsh-plugin-runtime'
import { BaseConfig, type Config as Options } from './config.ts'
import { EvidenceControl } from './control.ts'
import { EvidenceCompactorManager } from './manager.ts'

export const name = 'evidence-compactor'
export const inject = EvidenceCompactorManager.inject
export const Config = editableConfig(BaseConfig)
export const apply = managedApply(BaseConfig, (ctx: Context, config: Options) => {
  const manager = new EvidenceCompactorManager(ctx, config)
  ctx.inject(['typert'], (scope) => {
    new EvidenceControl(scope, manager)
  })
})
export type { Config as EvidenceCompactorConfig } from './config.ts'
export { EvidenceCompactorManager } from './manager.ts'
export { default as EvidenceCompactionEngine } from './runtime.ts'
