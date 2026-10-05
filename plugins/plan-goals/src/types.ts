import type { SessionId } from '@deepseek-ai/dsh-session/types'
export interface PlanStep {
  title: string
  acceptance: string
  evidence?: string
}
export interface SisyphusPlan {
  id: string
  revision: number
  goalId: string
  title: string
  steps: PlanStep[]
  index: number
  failures: number
  notice?: string
  pendingEvidence?: string
  phase: 'active' | 'review' | 'paused' | 'blocked' | 'complete'
}
export type { SessionId }
