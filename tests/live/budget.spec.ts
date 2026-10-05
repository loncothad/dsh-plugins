import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { QualificationBudget } from './budget.mjs'

it('serializes reservations, fences other processes, retains unknown charges and enforces the aggregate cap after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-live-budget-'))
  let budget = await QualificationBudget.open(dir)
  try {
    await expect(QualificationBudget.open(dir)).rejects.toThrow()
    const reservations = await Promise.all([
      budget.reserve('first', 10),
      budget.reserve('second', 10),
    ])
    await budget.complete(reservations[0]!, { status: 'passed' })
    await expect(budget.reserve('too-large', 6)).rejects.toThrow('$25')
    await expect(budget.reserve('first', 1)).rejects.toThrow('previous reservations')
    await budget.close()
    budget = await QualificationBudget.open(dir)
    expect(budget.reservedUsd).toBe(20)
    expect(budget.ledger[1]?.result).toBeUndefined()
    await budget.reserve('final', 5)
    expect(JSON.parse(await readFile(join(dir, 'live-reservations.json'), 'utf8'))).toHaveLength(3)
    await expect(budget.reserve('past-cap', 0.001)).rejects.toThrow('$25')
  } finally {
    await budget.close()
    await rm(dir, { recursive: true, force: true })
  }
})
