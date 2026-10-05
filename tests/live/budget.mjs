/** Private, crash-conservative reservations shared by all live qualification commands. */
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
export function qualificationDirectory() {
  const directory = process.env.DSH_QUALIFICATION_BUDGET_DIR
  if (!directory || !isAbsolute(directory))
    throw new Error(
      'Set DSH_QUALIFICATION_BUDGET_DIR to the same absolute private reservation directory for every paid qualification command',
    )
  return directory
}
export class QualificationBudget {
  constructor(directory, lock, ledger) {
    this.directory = directory
    this.lock = lock
    this.ledger = ledger
    this.queue = Promise.resolve()
    this.failed = false
    this.closed = false
  }
  static async open(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const lock = await open(join(directory, 'live-reservations.lock'), 'wx', 0o600)
    try {
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      )
      await lock.sync()
      let ledger = []
      try {
        ledger = JSON.parse(await readFile(join(directory, 'live-reservations.json'), 'utf8'))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (
        !Array.isArray(ledger) ||
        ledger.length > 2048 ||
        ledger.some(
          (row) =>
            !row ||
            typeof row.operation !== 'string' ||
            !Number.isFinite(row.maximumUsd) ||
            row.maximumUsd <= 0,
        ) ||
        new Set(ledger.map((row) => row.operation)).size !== ledger.length ||
        ledger.reduce((sum, row) => sum + row.maximumUsd, 0) > 25
      )
        throw new Error('Invalid spending ledger; do not dispatch provider requests')
      return new QualificationBudget(directory, lock, ledger)
    } catch (error) {
      await lock.close()
      await unlink(join(directory, 'live-reservations.lock'))
      throw error
    }
  }
  get reservedUsd() {
    return this.ledger.reduce((sum, row) => sum + row.maximumUsd, 0)
  }
  change(operation) {
    const result = this.queue.then(async () => {
      if (this.closed || this.failed)
        throw new Error('Qualification spending ledger is unavailable')
      try {
        return await operation()
      } catch (error) {
        if (!error.budgetInput) this.failed = true
        throw error
      }
    })
    this.queue = result.catch(() => {})
    return result
  }
  reserve(operation, maximumUsd) {
    return this.change(async () => {
      const invalid = (message) => {
        const error = new Error(message)
        error.budgetInput = true
        throw error
      }
      if (
        !/^[a-z0-9-]{1,100}$/.test(operation) ||
        this.ledger.some((row) => row.operation === operation)
      )
        invalid(
          'Use a new explicit operation ID; previous reservations are never refunded automatically',
        )
      if (!Number.isFinite(maximumUsd) || maximumUsd <= 0 || this.reservedUsd + maximumUsd > 25)
        invalid('The $25 aggregate cap prevents this provider request')
      const row = { operation, maximumUsd }
      this.ledger.push(row)
      await this.persist()
      return row
    })
  }
  complete(row, result) {
    return this.change(async () => {
      if (!this.ledger.includes(row)) throw new Error('Unknown spending reservation')
      row.result = result
      await this.persist()
    })
  }
  async persist() {
    const target = join(this.directory, 'live-reservations.json'),
      temporary = `${target}.pending`
    const text = `${JSON.stringify(this.ledger, null, 2)}\n`
    if (Buffer.byteLength(text) > 1048576)
      throw new Error('Spending ledger exceeds its bounded size')
    const file = await open(temporary, 'w', 0o600)
    try {
      await file.writeFile(text)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, target)
    if (process.platform !== 'win32') {
      const dir = await open(this.directory, 'r')
      try {
        await dir.sync()
      } finally {
        await dir.close()
      }
    }
  }
  async close() {
    await this.queue
    this.closed = true
    await this.lock.close()
    await unlink(join(this.directory, 'live-reservations.lock'))
  }
}
