/**
 * Shared OpenAI-compatible adapter base for dsh provider plugins.
 *
 * @module @loncothad/dsh-llm-openai-compat
 */

export type {
  CatalogModel,
  CatalogReasoning,
  CatalogReasoningEffort,
  OpenAICompatAdapterOptions,
} from './adapter.ts'
export { OpenAICompatAdapter, toModelReasoning } from './adapter.ts'
