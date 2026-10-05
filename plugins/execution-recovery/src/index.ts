import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'
import {
  type ExecutionAuthority,
  ExecutionJournal,
  fingerprint,
} from '@loncothad/dsh-execution-core'
import {
  abortable,
  editableConfig,
  managedApply,
  registerPrivateStateReader,
} from '@loncothad/dsh-plugin-runtime'
export const name = 'execution-recovery'
export const inject = ['commands', 'agents', 'sessions', 'sessionProjections']
const schema = z.object({
  dataDir: z
    .string()
    .description(
      'Absolute private journal directory, normally $DSH_HOME/execution. Keep the deployment home outside agent workspaces and protect it through environment policy.',
    ),
  leaseMs: z
    .number()
    .step(1)
    .min(3000)
    .max(3600000)
    .default(90000)
    .description(
      'Worker ownership interval. Healthy owners renew every third of this interval; expired owners cannot publish.',
    ),
  maxConcurrentJobs: z
    .number()
    .step(1)
    .min(1)
    .max(32)
    .default(8)
    .description(
      'Maximum active owned plugin jobs. Admission fails explicitly rather than growing an unbounded queue.',
    ),
  operationTimeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .max(3600000)
    .default(300000)
    .description(
      'Total consumer deadline, including owned API work. Cancellation never grants permission to repeat an unknown side effect.',
    ),
})
export const Config = editableConfig(schema)
type Policy = {
  dataDir?: string
  leaseMs: number
  maxConcurrentJobs: number
  operationTimeoutMs: number
}
class Recovery implements ExecutionAuthority {
  private readonly lifetime = new AbortController()
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<unknown> }
  >()
  constructor(
    private readonly ctx: Context,
    private readonly policy: Policy,
    private readonly journal: ExecutionJournal,
  ) {}
  async run<T>(
    input: Parameters<ExecutionAuthority['run']>[0],
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ id: string; value: T }> {
    this.ctx.get('environmentIsolation')?.assert()
    signal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    const session = this.ctx.sessions.get(SessionId(input.sessionId))
    if (!session) throw new Error('Leased execution requires a live session')
    const scope =
      this.ctx.get('environmentIsolation')?.scope(input.sessionId) ??
      `dev/${fingerprint(input.sessionId)}`
    const id = fingerprint({ scope, kind: input.kind, id: input.id, payloadRef: input.payloadRef })
    const prior = this.active.get(id)
    if (prior) return prior.promise as Promise<{ id: string; value: T }>
    if (this.active.size >= this.policy.maxConcurrentJobs)
      throw new Error('Leased execution admission capacity exceeded')
    const controller = new AbortController(),
      deadline = AbortSignal.any([
        signal,
        controller.signal,
        this.lifetime.signal,
        AbortSignal.timeout(this.policy.operationTimeoutMs),
      ])
    const promise = this.perform<T>(
      {
        id,
        scope,
        kind: input.kind,
        payload: input.payloadRef,
        retrySafe: input.retrySafe,
        maxAttempts: input.maxAttempts ?? 1,
      },
      deadline,
      operation,
    )
      .then((value) => ({ id, value }))
      .finally(() => this.active.delete(id))
    this.active.set(id, { controller, promise })
    return promise
  }
  private async perform<T>(
    input: Parameters<import('@loncothad/dsh-execution-core').LeaseJournal['submit']>[0],
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const job = await this.journal.call('submit', input)
    if (job.status === 'complete') return job.result as T
    if (job.status === 'dead')
      throw new Error(
        'This operation is a dead letter. Inspect its outcome before submitting a new operation.',
      )
    const lease = await this.claimExact(job.id, input.scope)
    if (!lease)
      throw new Error('Another worker owns this operation; wait for expiry or inspect its status')
    let renewing = false
    const leaseController = new AbortController(),
      ownedSignal = AbortSignal.any([signal, leaseController.signal])
    const timer = setInterval(
      () => {
        if (renewing || ownedSignal.aborted) return
        renewing = true
        void this.journal
          .call('renew', job.id, lease.token, this.policy.leaseMs)
          .catch(() => {
            leaseController.abort(new Error('Execution lease was lost'))
          })
          .finally(() => {
            renewing = false
          })
      },
      Math.floor(this.policy.leaseMs / 3),
    )
    timer.unref()
    try {
      ownedSignal.throwIfAborted()
      const result = await abortable(operation(ownedSignal), ownedSignal)
      ownedSignal.throwIfAborted()
      await this.journal.call('complete', job.id, lease.token, result)
      return result
    } catch (error) {
      await this.journal
        .call(
          'fail',
          job.id,
          lease.token,
          ownedSignal.aborted
            ? 'Operation cancelled or timed out; outcome may be unknown'
            : 'Consumer failed; inspect before replay',
          false,
          0,
        )
        .catch(() => {})
      throw error
    } finally {
      clearInterval(timer)
    }
  }
  private async claimExact(id: string, scope: string) {
    const candidate = await this.journal.call('get', id)
    if (!candidate || candidate.scope !== scope) return undefined
    return this.journal.call('claim', scope, this.policy.leaseMs, Date.now(), id)
  }
  async inspect(sessionId: string, dead: boolean) {
    const scope =
      this.ctx.get('environmentIsolation')?.scope(sessionId) ?? `dev/${fingerprint(sessionId)}`
    return (await this.journal.call('inspect', scope, dead ? 'dead' : undefined, 64)).map(
      ({ id, kind, status, attempts, maxAttempts, leaseUntil, reason, retrySafe }) => ({
        id,
        kind,
        status,
        attempts,
        maxAttempts,
        leaseUntil,
        reason,
        retrySafe,
      }),
    )
  }
  async readResult<T>(sessionId: string, id: string, kind: string): Promise<T> {
    this.ctx.get('environmentIsolation')?.assert()
    const scope =
        this.ctx.get('environmentIsolation')?.scope(sessionId) ?? `dev/${fingerprint(sessionId)}`,
      job = await this.journal.call('get', id)
    if (!job || job.scope !== scope || job.kind !== kind || job.status !== 'complete')
      throw new Error('The scoped operation result is unavailable')
    return job.result as T
  }
  async stop(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.active.values()].map((job) => job.promise))
    await this.journal.close()
  }
}
async function activate(
  ctx: Context,
  input: Partial<Policy>,
  options: { workerUrl?: URL } = {},
): Promise<void> {
  const policy = schema(input) as Policy,
    dataDir =
      policy.dataDir?.trim() || join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'execution')
  if (!isAbsolute(dataDir)) throw new Error('Execution journal directory must be absolute')
  const journal = await ExecutionJournal.open(join(dataDir, 'journal.sqlite'), options),
    service = new Recovery(ctx, policy, journal)
  ctx.effect(
    () => () => journal.close(),
    'execution-recovery: release journal after failed activation',
  )
  await journal.call('reap')
  let reclaiming = false
  const reaper = setInterval(() => {
    if (reclaiming) return
    reclaiming = true
    void journal
      .call('reap')
      .catch(() => {})
      .finally(() => {
        reclaiming = false
      })
  }, 5000)
  reaper.unref()
  ctx.effect(
    () => () => clearInterval(reaper),
    'execution-recovery: stop bounded lease reclamation',
  )
  registerPrivateStateReader(ctx, 'executionRecovery', (id) =>
    service.inspect(id, false).then((rows) => rows.slice(0, 32)),
  )
  ctx.provide('executionRecovery', service)
  ctx.commands.register({
    name: 'runs',
    description: 'Inspect retained plugin operations and dead letters',
    input: { hint: 'list | dead' },
    handler: async (invocation) => {
      invocation.signal.throwIfAborted()
      const action = invocation.rawInput.trim() || 'list'
      if (action !== 'list' && action !== 'dead')
        return {
          kind: 'error',
          text: 'Use /runs list or /runs dead. Unknown side effects are never blindly replayed.',
        }
      return {
        kind: 'success',
        text: JSON.stringify(
          await service.inspect(invocation.agent.id, action === 'dead'),
          null,
          2,
        ),
      }
    },
  })
  ctx.effect(
    () => () => service.stop(),
    'execution-recovery: cancel consumers, drain leases and close worker',
  )
}
export const apply = managedApply(schema, activate)
