import { expect, it } from 'vitest'
import { type AssemblyUnit, assemble, ContextOverflow, workingBudget } from '../src/assemble.ts'

const budget = { contextWindow: 200, outputReserve: 20, safety: 10, nextToolResultReserve: 20 }
const adapter = {
  materialize: (units: readonly string[]) => ({ tools: 'tool-schema', units }),
  count: (request: { tools: string; units: readonly string[] }) =>
    request.tools.length + request.units.reduce((sum, value) => sum + value.length, 0),
  validate: () => {},
}
const signal = () => new AbortController().signal

it('retains an older correction before fresh successful bulk output while preserving mandatory controls', async () => {
  const units: AssemblyUnit<string>[] = [
    { id: 'controls', kind: 'pin', closed: true, content: 'c'.repeat(20) },
    {
      id: 'old-correction',
      kind: 'interaction',
      closed: true,
      content: 'x'.repeat(35),
      importance: 95,
    },
    { id: 'old-read', kind: 'interaction', closed: true, content: 'r'.repeat(35), importance: 10 },
    {
      id: 'recent-success',
      kind: 'interaction',
      closed: true,
      content: 's'.repeat(35),
      importance: 20,
    },
  ]
  const result = await assemble(units, budget, adapter, signal())
  expect(result.selected.map((row) => row.id)).toEqual(['controls', 'old-correction'])
  expect(result.omitted).toContain('recent-success')
  await expect(
    assemble([{ ...units[0]!, importance: Infinity }], budget, adapter, signal()),
  ).rejects.toThrow('importance')
})

it('accounts for the native request envelope and reserves output and next-tool headroom', () => {
  expect(workingBudget(budget)).toEqual({
    hardInput: 170,
    workingInput: 150,
    trigger: 120,
    target: 82,
  })
  expect(workingBudget({ ...budget, providerMaxInput: 100 }).workingInput).toBe(70)
  expect(() => workingBudget({ ...budget, contextWindow: 10 })).toThrow('budget')
})

it('keeps instructions, exact pins, latest user input, and open protocol groups while evicting old complete exchanges', async () => {
  const units: AssemblyUnit<string>[] = [
    { id: 'system', kind: 'instructions', content: 'exact instructions', closed: true },
    { id: 'pin', kind: 'pin', content: 'never publish', closed: true },
    ...Array.from({ length: 12 }, (_, id) => ({
      id: `exchange-${id}`,
      kind: 'interaction' as const,
      content: 'past exchange',
      closed: true,
    })),
    { id: 'open-tool', kind: 'interaction', content: 'pending call', closed: false },
    { id: 'user', kind: 'latest-user', content: 'latest request', closed: true },
  ]
  const value = await assemble(units, budget, adapter, signal())
  expect(value.inputTokens).toBeLessThanOrEqual(150)
  expect(value.selected.map((unit) => unit.id)).toEqual(
    expect.arrayContaining(['system', 'pin', 'open-tool', 'user']),
  )
  expect(value.request.units).toContain('never publish')
  expect(value.omitted[0]).toBe('exchange-0')
})

it('masks an observation only when the final serialized request shrinks', async () => {
  const value = await assemble(
    [
      { id: 'user', kind: 'latest-user', content: 'continue', closed: true },
      {
        id: 'tool-group',
        kind: 'interaction',
        content: 'x'.repeat(150),
        masked: 'call/result: original evidence remains retrievable',
        closed: true,
      },
    ],
    budget,
    adapter,
    signal(),
  )
  expect(value.selected).toContainEqual({ id: 'tool-group', mode: 'masked' })
  expect(value.omitted).toEqual([])
})

it('reports mandatory overflow explicitly and does not wait for an extractor', async () => {
  await expect(
    assemble(
      [{ id: 'system', kind: 'instructions', content: 's'.repeat(180), closed: true }],
      budget,
      adapter,
      signal(),
    ),
  ).rejects.toBeInstanceOf(ContextOverflow)
  const abort = new AbortController()
  abort.abort(new Error('cancelled'))
  await expect(assemble([], budget, adapter, abort.signal)).rejects.toThrow('cancelled')
})

it('retains recent exchanges when mandatory content makes the reduction target unattainable', async () => {
  const value = await assemble(
    [
      { id: 'system', kind: 'instructions', content: 's'.repeat(100), closed: true },
      { id: 'old', kind: 'interaction', content: 'o'.repeat(50), closed: true },
      { id: 'recent', kind: 'interaction', content: 'r'.repeat(20), closed: true },
    ],
    budget,
    adapter,
    signal(),
  )
  expect(value.inputTokens).toBeLessThanOrEqual(value.budget.workingInput)
  expect(value.selected.map((unit) => unit.id)).toEqual(['system', 'recent'])
})
