/** Context selection depends on the final native request counter, never on compressed archive size. */
export interface InputBudget {
  contextWindow: number
  providerMaxInput?: number
  outputReserve: number
  safety: number
  nextToolResultReserve: number
}
export interface WorkingBudget {
  hardInput: number
  workingInput: number
  trigger: number
  target: number
}
export function workingBudget(value: InputBudget): WorkingBudget {
  for (const [name, amount] of Object.entries(value)) {
    if (name === 'providerMaxInput' && amount === undefined) continue
    if (
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      ((name === 'contextWindow' || name === 'providerMaxInput') && amount === 0)
    )
      throw new Error(`Invalid compaction budget: ${name}`)
  }
  const hardInput =
    Math.min(value.providerMaxInput ?? Infinity, value.contextWindow - value.outputReserve) -
    value.safety
  const workingInput = hardInput - value.nextToolResultReserve
  if (workingInput <= 0) throw new Error('Compaction has no working input budget')
  return {
    hardInput,
    workingInput,
    trigger: Math.floor(workingInput * 0.8),
    target: Math.floor(workingInput * 0.55),
  }
}
export class ContextOverflow extends Error {
  readonly code = 'MANDATORY_CONTEXT_OVERFLOW'
  constructor(
    readonly inputTokens: number,
    readonly inputLimit: number,
  ) {
    super(
      `Mandatory context requires ${inputTokens} tokens; the working input limit is ${inputLimit}`,
    )
  }
}
export interface AssemblyUnit<T> {
  id: string
  kind: 'instructions' | 'pin' | 'latest-user' | 'interaction' | 'memory' | 'retrieval'
  content: T
  /** A closed unit includes every required call/result dependency. Open units cannot be evicted. */
  closed: boolean
  mandatory?: boolean
  /** Adapter-owned, protocol-valid masking of bulky observations in this complete unit. */
  masked?: T
  /** Host-assigned retention priority, 0–100. It does not make a unit mandatory or authorize actions. */
  importance?: number
  importanceReasons?: readonly string[]
}
export interface AssemblyAdapter<T, Request> {
  materialize(units: readonly T[]): Request
  /** Includes tools, wrappers, and modality costs in the final serialized request. */
  count(request: Request): number | Promise<number>
  validate(request: Request): void
}
export interface Assembled<Request> {
  request: Request
  inputTokens: number
  selected: { id: string; mode: 'original' | 'masked' }[]
  omitted: string[]
  budget: WorkingBudget
}

/** Extraction is deliberately absent: a request can be prepared while extraction is offline. */
export async function assemble<T, Request>(
  units: readonly AssemblyUnit<T>[],
  limits: InputBudget,
  adapter: AssemblyAdapter<T, Request>,
  signal: AbortSignal,
): Promise<Assembled<Request>> {
  if (units.length > 2048 || new Set(units.map((unit) => unit.id)).size !== units.length)
    throw new Error('Invalid compaction assembly units')
  if (
    units.some(
      (unit) =>
        unit.importance !== undefined &&
        (!Number.isFinite(unit.importance) || unit.importance < 0 || unit.importance > 100),
    )
  )
    throw new Error('Invalid retention importance')
  const budget = workingBudget(limits)
  const selected = new Map(units.map((unit) => [unit.id, 'original' as 'original' | 'masked']))
  const mandatory = (unit: AssemblyUnit<T>) =>
    unit.mandatory || !unit.closed || ['instructions', 'pin', 'latest-user'].includes(unit.kind)
  const count = async () => {
    signal.throwIfAborted()
    const request = adapter.materialize(
      units
        .filter((unit) => selected.has(unit.id))
        .map((unit) => (selected.get(unit.id) === 'masked' ? unit.masked! : unit.content)),
    )
    adapter.validate(request)
    const inputTokens = await adapter.count(request)
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0)
      throw new Error('Adapter returned an invalid request token count')
    signal.throwIfAborted()
    return { request, inputTokens }
  }
  const result = (value: { request: Request; inputTokens: number }): Assembled<Request> => ({
    ...value,
    selected: units
      .filter((unit) => selected.has(unit.id))
      .map((unit) => ({ id: unit.id, mode: selected.get(unit.id)! })),
    omitted: units.filter((unit) => !selected.has(unit.id)).map((unit) => unit.id),
    budget,
  })
  let current = await count()
  if (current.inputTokens <= budget.trigger) return result(current)
  const allSelected = new Map(selected)
  for (const unit of units) if (!mandatory(unit)) selected.delete(unit.id)
  const required = await count()
  if (required.inputTokens > budget.workingInput)
    throw new ContextOverflow(required.inputTokens, budget.workingInput)
  selected.clear()
  for (const [id, mode] of allSelected) selected.set(id, mode)
  // When mandatory content already exceeds the reduction target, retain recent
  // complete exchanges up to the hard working budget instead of chasing an impossible target.
  const target = required.inputTokens > budget.target ? budget.workingInput : budget.target
  // Mask old bulky observations without separating tool protocol dependencies.
  for (const unit of [...units].sort(
    (left, right) => (left.importance ?? 50) - (right.importance ?? 50),
  )) {
    if (mandatory(unit) || unit.masked === undefined) continue
    selected.set(unit.id, 'masked')
    const candidate = await count()
    if (candidate.inputTokens < current.inputTokens) current = candidate
    else selected.set(unit.id, 'original')
    if (current.inputTokens <= target) return result(current)
  }
  const recent = new Set(
    units
      .filter((unit) => unit.kind === 'interaction' && unit.closed)
      .slice(-10)
      .map((unit) => unit.id),
  )
  const candidates = [
    ...units.filter((unit) => !mandatory(unit) && !recent.has(unit.id)),
    ...units.filter((unit) => !mandatory(unit) && recent.has(unit.id)),
  ].sort((left, right) => (left.importance ?? 50) - (right.importance ?? 50))
  for (const unit of candidates) {
    selected.delete(unit.id)
    current = await count()
    if (current.inputTokens <= target) return result(current)
  }
  if (current.inputTokens > budget.workingInput)
    throw new ContextOverflow(current.inputTokens, budget.workingInput)
  return result(current)
}
