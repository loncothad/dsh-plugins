export interface Reservation {
  operation: string
  maximumUsd: number
  result?: unknown
}
export class QualificationBudget {
  static open(directory: string): Promise<QualificationBudget>
  readonly ledger: Reservation[]
  readonly reservedUsd: number
  reserve(operation: string, maximumUsd: number): Promise<Reservation>
  complete(row: Reservation, result: unknown): Promise<void>
  change<T>(operation: () => Promise<T>): Promise<T>
  persist(): Promise<void>
  close(): Promise<void>
}
export function qualificationDirectory(): string
