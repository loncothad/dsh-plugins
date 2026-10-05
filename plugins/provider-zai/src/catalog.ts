/**
 * Z.AI GLM coding-plan catalog data: endpoints and model tables.
 *
 * ZCode's current coding-plan templates advertise GLM-5.3 and
 * GLM-5.3-Flash, with low/high/max reasoning. Retired and unadvertised
 * coding-plan entries are not synthesized. The output limit travels as
 * `max_tokens`.
 *
 * @module @loncothad/dsh-provider-zai/catalog
 */

import type { CatalogModel } from '@loncothad/dsh-llm-openai-compat'

/** Z.AI coding plan endpoint. */
export const ZAI_ENDPOINT = 'https://api.z.ai/api/coding/paas/v4/chat/completions'

/** Z.AI Coding CN (Zhipu) endpoint. */
export const ZAI_CODING_CN_ENDPOINT = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'

/** Efforts the GLM-5.3 family accepts (thinking is forced; default max). */
const GLM_53_EFFORTS = [
  { id: 'low', name: 'Low', description: 'Mild inference, fastest.' },
  { id: 'high', name: 'High', description: 'Deep inference on hard problems.' },
  { id: 'max', name: 'Max', description: 'Default and recommended: deepest inference.' },
]

/** Coding-plan models advertised by ZCode 29628c9acdb81b703bbd4080c207a0e7ce5e276e.
 * config/provider/zcode-builtin.json exposes these two IDs for zai-api and bigmodel-api.
 * The catalog is a source snapshot, not an account-entitlement promise.
 */
export const ZAI_MODELS: readonly CatalogModel[] = [
  {
    id: 'GLM-5.3',
    name: 'GLM-5.3',
    contextWindow: 1_000_000,
    description: 'ZCode coding-plan flagship; availability depends on the signed-in plan.',
    reasoning: { efforts: GLM_53_EFFORTS, defaultEffort: 'max' },
  },
  {
    id: 'GLM-5.3-Flash',
    name: 'GLM-5.3 Flash',
    contextWindow: 1_000_000,
    description: 'ZCode coding-plan Flash model; availability depends on the signed-in plan.',
    reasoning: { efforts: GLM_53_EFFORTS, defaultEffort: 'max' },
  },
]
/** The same advertised coding-plan model IDs on BigModel's regional route. */
export const ZAI_CODING_CN_MODELS: readonly CatalogModel[] = ZAI_MODELS
