import type { Context } from '@deepseek-ai/cordis'
import type { SecretsAuthority } from '@loncothad/dsh-execution-core'
import {
  abortable,
  editableConfig,
  managedApply,
  registerStatus,
} from '@loncothad/dsh-plugin-runtime'
import { type Policy, referencesSchema, schema } from './config.ts'
import { type ProviderInternals, readSecret } from './providers.ts'

export { readSecret } from './providers.ts'
export const name = 'secrets-broker'
export const inject = ['commands']
export const Config = editableConfig(schema)
function activate(ctx: Context, input: Partial<Policy>, internals: ProviderInternals = {}): void {
  const policy = schema(input) as Policy
  policy.references = referencesSchema.parse(policy.references)
  const lifetime = new AbortController(),
    known = new Set<string>()
  let active = 0
  const remember = (value: string) => {
    if (!known.has(value) && known.size >= policy.maxRedactionValues)
      throw new Error('Credential redaction history capacity exceeded')
    known.add(value)
  }
  const redact = (text: string) => {
    let output = text
    for (const value of known) {
      for (const variant of new Set([
        value,
        JSON.stringify(value).slice(1, -1),
        encodeURIComponent(value),
        Buffer.from(value, 'utf8').toString('base64'),
      ]))
        if (variant) output = output.replaceAll(variant, '[redacted]')
    }
    return output
  }
  const service: SecretsAuthority = {
    redact,
    async withCredentials<T>(
      consumer: string,
      sessionId: string,
      references: readonly string[],
      signal: AbortSignal,
      operation: (values: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
      const boundary = ctx.get('environmentIsolation')
      if (!boundary) throw new Error('Environment Isolation is required for secret delivery')
      boundary.assert()
      if (
        !consumer ||
        !sessionId ||
        references.length < 1 ||
        references.length > 16 ||
        new Set(references).size !== references.length
      )
        throw new Error('Invalid credential scope')
      if (active >= policy.maxConcurrentLeases)
        throw new Error('Credential lease admission capacity exceeded')
      const identity = boundary.identity,
        selected = references.map((id) => {
          const row = policy.references.find((row) => row.id === id)
          if (!row || row.environment !== boundary.environment || !row.consumers.includes(consumer))
            throw new Error(
              'This consumer or environment is not authorized for the secret reference',
            )
          return row
        })
      const deadline = AbortSignal.any([
        signal,
        lifetime.signal,
        AbortSignal.timeout(policy.leaseMs),
      ])
      active++
      try {
        const values: Record<string, string> = Object.create(null)
        for (const row of selected) {
          const value = await abortable(readSecret(policy, row, deadline, internals), deadline)
          remember(value)
          values[row.id] = value
        }
        boundary.assert()
        if (boundary.identity !== identity)
          throw new Error('Credential deployment generation changed')
        const result = await abortable(operation(Object.freeze(values), deadline), deadline)
        deadline.throwIfAborted()
        boundary.assert()
        if (boundary.identity !== identity)
          throw new Error('Credential deployment generation changed')
        return result
      } catch {
        throw new Error(
          deadline.aborted
            ? 'Credential operation cancelled or expired'
            : 'Scoped credential retrieval or consumer execution failed',
        )
      } finally {
        active--
      }
    },
  }
  ctx.provide('secretsBroker', service)
  registerStatus(ctx, 'secrets', () => ({
    ready: Boolean(ctx.get('environmentIsolation')?.valid),
    message: ctx.get('environmentIsolation')?.valid
      ? 'Credential scope is bound to the verified deployment.'
      : 'Enable and configure Environment Isolation before borrowing credentials.',
    fields: [
      { label: 'Platform', value: internals.platform ?? process.platform },
      { label: 'Configured references', value: String(policy.references.length) },
      { label: 'Active credential leases', value: String(active) },
      { label: 'Model access', value: 'No raw-secret tool or RPC method' },
      {
        label: 'Third-party sign-in',
        value: 'Operator-owned CLI/vault session; values never enter chat',
      },
    ],
  }))
  ctx.commands.register({
    name: 'secrets',
    description: 'Inspect credential references and scope without resolving secret values',
    handler: (invocation) => {
      invocation.signal.throwIfAborted()
      return {
        kind: 'success',
        text: JSON.stringify(
          {
            environment: ctx.get('environmentIsolation')?.environment ?? 'unverified',
            references: policy.references.map(({ id, environment, provider, consumers }) => ({
              id,
              environment,
              provider,
              consumers,
            })),
            activeLeases: active,
          },
          null,
          2,
        ),
      }
    },
  })
  ctx.effect(
    () => () => {
      lifetime.abort()
      known.clear()
    },
    'secrets-broker: expire borrowed authority and release redaction history',
  )
}
export const apply = managedApply(schema, activate)
