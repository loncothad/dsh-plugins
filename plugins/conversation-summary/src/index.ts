import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { fingerprint } from '@loncothad/dsh-execution-core'
import {
  editableConfig,
  managedApply,
  PluginState,
  registerPrivateStateReader,
} from '@loncothad/dsh-plugin-runtime'
import { type Policy, policySchema, resolvePolicy } from './config.ts'
import { registerSummaryContent } from './content.ts'
import {
  collectWindow,
  decisionAnswer,
  foldSummary,
  initialState,
  localDigest,
  type Receipt,
  stateSchema,
  type Window,
} from './domain.ts'
import { generate } from './model.ts'

export type { Receipt, SummaryState } from './domain.ts'
export { collectWindow, foldSummary, initialState, receiptSchema, stateSchema } from './domain.ts'
export const name = 'conversation-summary'
export const inject = ['commands', 'tools', 'sessions', 'sessionQuery', 'sessionProjections', 'llm']
export const Config = editableConfig(policySchema)
async function activate(ctx: Context, input: Partial<Policy>): Promise<void> {
  const policy = resolvePolicy(input),
    lifetime = new AbortController()
  registerSummaryContent(ctx)
  const store = await PluginState.open(
    ctx,
    'conversationSummary',
    initialState,
    (value) => stateSchema.parse(value),
    { directory: policy.stateDirectory },
  )
  registerPrivateStateReader(ctx, 'conversationSummary', async (id) => {
    const session = ctx.sessions.get(id as Session['id'])
    if (!session) throw new Error('Open the session before reading summaries')
    return store.read(session)
  })
  const state = (session: Session) => store.get(session)
  const change = (session: Session, type: string, data: unknown) =>
    store.update(session, (value) =>
      foldSummary(value, { type, data, seq: session.snapshotEvents().at(-1)?.seq ?? -1 } as never),
    )
  const pending = new Map<
      Session,
      {
        trigger: Receipt['trigger'] | 'automatic'
        resolve: (value: string) => void
        promise: Promise<string>
      }
    >(),
    active = new Map<
      Session,
      {
        controller: AbortController
        promise: Promise<string>
        again?: Receipt['trigger'] | 'automatic'
      }
    >()
  let closed = false
  const modelJob = async (
    session: Session,
    kind: 'summary' | 'decision',
    window: Window,
    signal: AbortSignal,
  ): Promise<{ text: string; ref: string }> => {
    const recovery = ctx.get('executionRecovery')
    if (!recovery) throw new Error('Execution Recovery is required for auxiliary model jobs')
    const payloadRef = {
      fromSeq: window.fromSeq,
      throughSeq: window.throughSeq,
      bodyHash: fingerprint(window.body),
      policyHash: fingerprint(policy),
    }
    const result = await recovery.run(
      {
        id: fingerprint({ kind, ...payloadRef }),
        sessionId: session.id,
        kind: `conversation-${kind}`,
        payloadRef,
        retrySafe: false,
      },
      signal,
      async (owned) => {
        const text = await generate(ctx, policy, kind, window.body, owned, () =>
          reserve(session, owned),
        )
        if (kind === 'decision') decisionAnswer(text)
        return { text }
      },
    )
    return { text: result.value.text, ref: result.id }
  }
  const run = async (
    session: Session,
    trigger: Receipt['trigger'] | 'automatic',
    signal: AbortSignal,
  ): Promise<string> => {
    await store.ensure(session)
    if (!(await ctx.sessions.flush(session)))
      throw new Error('Summary coverage requires durable original session storage')
    const before = state(session),
      log = await ctx.sessionQuery.readSession(session.id)
    signal.throwIfAborted()
    const window = collectWindow(log.events, before.cursor, policy.maxInputCharacters)
    if (!window) return 'No unsummarized completed conversation evidence.'
    let selected: Receipt['trigger'] = trigger === 'automatic' ? 'turns' : trigger
    if (trigger === 'automatic') {
      const turns = log.events.filter(
        (event) => event.type === 'turn/end' && event.seq > before.cursor,
      ).length
      const periodic =
        ['turns', 'turns-or-decision'].includes(policy.automatic) && turns >= policy.everyTurns
      if (!periodic) {
        const boundary = log.events.findLast((event) => event.type === 'turn/end')!.seq
        if (
          !['decision', 'turns-or-decision'].includes(policy.automatic) ||
          boundary <= before.evaluatedThrough
        )
          return 'No automatic summary is due.'
        await change(session, 'conversation-summary/evaluated', { throughSeq: boundary })
        await ctx.sessions.flush(session)
        selected = 'decision'
        if (decisionAnswer((await modelJob(session, 'decision', window, signal)).text) === 'WAIT')
          return 'Decision model chose to wait.'
      }
    }
    const generated =
      policy.generation === 'model' ? await modelJob(session, 'summary', window, signal) : undefined
    const text = generated ? undefined : localDigest(window, policy.maxSummaryCharacters)
    signal.throwIfAborted()
    if (
      closed ||
      ctx.sessions.get(session.id) !== session ||
      state(session).cursor !== before.cursor
    )
      throw new Error('Summary session or coverage changed before publication')
    const id = createHash('sha256')
      .update(`${session.id}:${window.fromSeq}:${window.throughSeq}`)
      .digest('hex')
    const row: Receipt = {
      version: 1,
      id,
      sessionId: session.id,
      fromSeq: window.fromSeq,
      throughSeq: window.throughSeq,
      requestThrough: before.requestThrough,
      ...(generated ? { externalRef: generated.ref } : { text: text! }),
      origin: policy.generation === 'model' ? 'external-model' : 'local',
      ...(policy.generation === 'model'
        ? { provider: policy.summaryProvider, model: policy.summaryModel }
        : {}),
      trigger: selected,
      turns: window.turns,
      pending: window.pending,
      createdAt: new Date().toISOString(),
    }
    // Private presentation state: no core session event, assistant message or context injection.
    await change(session, 'conversation-summary/delivered', row)

    return `Summary delivered for events ${window.fromSeq}–${window.throughSeq}.${window.pending ? ' More evidence remains for the next summary.' : ''}`
  }
  const reserve = async (session: Session, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (state(session).calls >= policy.maxModelCallsPerSession)
      throw new Error('This session has reached its auxiliary model call limit')
    await change(session, 'conversation-summary/attempt', {})

    signal.throwIfAborted()
  }
  const pump = () => {
    if (closed) return
    for (const [session, job] of pending) {
      if (active.size >= policy.maxConcurrentJobs) break
      pending.delete(session)
      const controller = new AbortController(),
        signal = AbortSignal.any([lifetime.signal, controller.signal])
      const promise = Promise.resolve()
        .then(() => run(session, job.trigger, signal))
        .catch(async () => {
          const message = signal.aborted
            ? 'Summary cancelled. Check the latest delivery status.'
            : 'Summary generation or persistence failed. Check the latest delivery status, model settings, capacity and resource limits.'
          if (!closed && ctx.sessions.get(session.id) === session) {
            await change(session, 'conversation-summary/failure', { message })
            await ctx.sessions.flush(session).catch(() => false)
          }
          return message
        })
        .finally(() => {
          const again = active.get(session)?.again
          active.delete(session)
          if (again && !closed && ctx.sessions.get(session.id) === session)
            void enqueue(session, again)
          pump()
        })
      active.set(session, { controller, promise })
      void promise.then(job.resolve)
    }
  }
  const enqueue = (
    session: Session,
    trigger: Receipt['trigger'] | 'automatic',
  ): Promise<string> => {
    if (closed) return Promise.resolve('The summary plugin is being disposed.')
    const running = active.get(session)
    if (running) {
      if (trigger === 'automatic' || trigger === 'model-request') running.again = trigger
      return running.promise
    }
    const queued = pending.get(session)
    if (queued) {
      if (trigger !== 'automatic') queued.trigger = trigger
      return queued.promise
    }
    if (pending.size >= 128)
      return Promise.resolve('The summary queue is full. Try again after current jobs finish.')
    let resolve!: (value: string) => void
    const promise = new Promise<string>((accept) => {
      resolve = accept
    })
    pending.set(session, { trigger, resolve, promise })
    pump()
    return promise
  }
  if (policy.commandEnabled)
    ctx.commands.register({
      name: 'summary',
      description: 'Deliver an incremental presentation-only conversation summary',
      input: { hint: 'now | status | cancel' },
      handler: async (invocation) => {
        invocation.signal.throwIfAborted()
        const session = invocation.agent.session,
          action = invocation.rawInput.trim() || 'now'
        if (action === 'status') {
          await store.ensure(session)
          const value = state(session)
          return {
            kind: 'success',
            text: `Summary coverage through event ${value.cursor}; ${value.calls}/${policy.maxModelCallsPerSession} auxiliary model calls.${value.error ? ` ${value.error}` : ''}`,
          }
        }
        if (action === 'cancel') {
          active.get(session)?.controller.abort()
          const job = pending.get(session)
          if (job) {
            pending.delete(session)
            job.resolve('Summary cancelled.')
          }
          return { kind: 'success', text: 'Summary cancellation requested.' }
        }
        if (action !== 'now')
          return { kind: 'error', text: 'Use /summary now, /summary status or /summary cancel.' }
        const task = enqueue(session, 'manual'),
          abort = () => {
            active.get(session)?.controller.abort(invocation.signal.reason)
            const queued = pending.get(session)
            if (queued) {
              pending.delete(session)
              queued.resolve('Summary cancelled.')
            }
          }
        invocation.signal.addEventListener('abort', abort, { once: true })
        try {
          return { kind: 'success', text: await task }
        } finally {
          invocation.signal.removeEventListener('abort', abort)
        }
      },
    })
  if (policy.toolEnabled)
    ctx.tools.register(
      defineTool({
        name: 'request_conversation_summary',
        description:
          'Signal that a human-facing incremental summary is useful. Delivery runs after this turn closes. External summary text stays outside your request context and is never returned by this tool.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        execute: async (_args, exec) => {
          exec.signal.throwIfAborted()
          if (!exec.agent) throw new Error('A live agent is required')
          await store.ensure(exec.agent.session)
          await change(exec.agent.session, 'conversation-summary/request', {})
          await ctx.sessions.flush(exec.agent.session)
          return 'Summary requested for delivery after this turn. The summary will appear in a separate human-facing card.'
        },
      }),
    )
  if (policy.skillEnabled && policy.toolEnabled)
    ctx.inject(['skills'], (scope) => {
      scope.skills.register({
        name: 'conversation-summary',
        description:
          'Signal useful incremental conversation summaries without importing external summary text into your context.',
        source: 'bundled',
        content:
          'Call request_conversation_summary after a meaningful milestone, decision, correction or failure that merits human attention. It queues a presentation-only summary after the current turn. Do not claim delivery before the host acknowledgement. Do not repeatedly request the same progress. External summary text is deliberately unavailable to the main model.',
      })
    })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    if (policy.automatic !== 'off') void enqueue(session, 'automatic')
    else if (policy.toolEnabled)
      void store
        .ensure(session)
        .then((value) => {
          if (value.requestThrough > value.deliveredRequestThrough)
            void enqueue(session, 'model-request')
        })
        .catch(() => {})
  })
  ctx.on('session/disposed', (session) => {
    active.get(session)?.controller.abort()
    const job = pending.get(session)
    if (job) {
      pending.delete(session)
      job.resolve('Summary session closed.')
    }
  })
  ctx.effect(
    () => async () => {
      closed = true
      lifetime.abort()
      for (const job of pending.values()) job.resolve('Summary plugin disposed.')
      pending.clear()
      await Promise.allSettled([...active.values()].map((job) => job.promise))
    },
    'conversation-summary: cancel queue and drain owned work',
  )
}
export const apply = managedApply(policySchema, activate)
