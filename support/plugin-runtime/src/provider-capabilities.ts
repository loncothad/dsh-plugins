/** Host-only subscription credentials resolved through the owning provider. */
export interface CodexSubscription {
  tokens(signal?: AbortSignal): Promise<{ accessToken: string; accountId?: string } | undefined>
  account(): Promise<string | undefined>
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    codexSubscription: CodexSubscription
  }
}
export interface OpenRouterDecisions {
  request(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    openrouterDecisions: OpenRouterDecisions
  }
}

import type { DecisionInput, DecisionResult } from '@loncothad/dsh-decision-core'

export type { DecisionInput, DecisionQuestion, DecisionResult } from '@loncothad/dsh-decision-core'
export interface DecisionModels {
  evaluate(input: DecisionInput, signal: AbortSignal): Promise<DecisionResult>
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    decisionModels: DecisionModels
  }
}
