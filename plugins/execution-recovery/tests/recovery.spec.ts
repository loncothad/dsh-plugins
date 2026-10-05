import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

const contexts: Context[] = [],
  dirs: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function fixture(dataDir?: string) {
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), 'dsh-execution-')))
  if (!dataDir) dirs.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  for (const service of [SessionStore, ProjectionRegistry, AgentRegistry, CommandRuntime])
    await ctx.plugin(service)
  const session = ctx.sessions.create(SessionId('recovery-session'))
  await apply(
    ctx,
    { dataDir: dir, leaseMs: 3000 },
    {
      workerUrl: new URL('../../../support/execution-core/lib/journal-worker.js', import.meta.url),
    },
  )
  return {
    ctx,
    session,
    dir,
    run: <T>(
      id: string,
      operation: (signal: AbortSignal) => Promise<T>,
      signal = new AbortController().signal,
    ) =>
      ctx.executionRecovery
        .run(
          {
            id,
            sessionId: session.id,
            kind: 'fixture',
            payloadRef: { target: id },
            retrySafe: false,
          },
          signal,
          operation,
        )
        .then((result) => result.value),
  }
}
it('recovers a committed result after restart without dispatching its consumer again', async () => {
  const first = await fixture()
  let calls = 0
  expect(
    await first.run('stable', async () => {
      calls++
      return { passed: true }
    }),
  ).toEqual({ passed: true })
  await first.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(first.ctx), 1)
  const next = await fixture(first.dir)
  expect(
    await next.run('stable', async () => {
      calls++
      return { passed: false }
    }),
  ).toEqual({ passed: true })
  expect(calls).toBe(1)
})
it('coalesces one operation while independent operations cannot claim each other', async () => {
  const f = await fixture()
  let release!: (value: string) => void,
    calls = 0
  const pending = f.run('one', async () => {
    calls++
    return new Promise<string>((resolve) => {
      release = resolve
    })
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  const duplicate = f.run('one', async () => {
    calls++
    return 'duplicate'
  })
  expect(await f.run('two', async () => 'separate')).toBe('separate')
  release('first')
  expect(await pending).toBe('first')
  expect(await duplicate).toBe('first')
  expect(calls).toBe(1)
})
it('retains cancellation as a dead letter and drains an uncooperative consumer', async () => {
  const f = await fixture(),
    controller = new AbortController()
  const task = f.run('cancelled', async () => new Promise<string>(() => {}), controller.signal)
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  controller.abort(new Error('cancelled'))
  await expect(task).rejects.toThrow('cancelled')
  await expect(f.run('cancelled', async () => 'blind replay')).rejects.toThrow('dead letter')
  await f.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(f.ctx), 1)
})
