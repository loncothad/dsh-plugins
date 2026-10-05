/** Complete configuration forms with serialized, symmetric capability replacement. */
import type { Context, Fiber, Volatile } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { isVolatile } from '@deepseek-ai/cosmokit'
import type {} from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'

export type {
  CodexSubscription,
  DecisionInput,
  DecisionModels,
  DecisionQuestion,
  DecisionResult,
  OpenRouterDecisions,
} from './provider-capabilities.ts'

const owners = new WeakMap<Fiber, Entry>()

/** The profile entry owning a capability, including capabilities mounted by managedApply. */
export function configEntry(ctx: Context): Entry | undefined {
  return owners.get(ctx.fiber) ?? ctx.fiber.entry
}

/** Expose all fields for atomic editing; individual references are restored inside each capability generation. */
export function editableConfig(schema: Schema): Schema {
  const copy = new Schema(schema.toJSON())
  const plain = (node: Schema): void => {
    delete node.meta.volatile
    for (const child of Object.values(node.dict ?? {})) plain(child)
    if (node.inner) plain(node.inner)
    for (const child of node.list ?? []) plain(child)
  }
  plain(copy)
  return copy.volatile()
}

/** Mount a capability generation and replace it after accepted configuration changes, awaiting cleanup first. */
export function managedApply<T, A extends unknown[]>(
  schema: Schema,
  activate: (ctx: Context, config: T, ...args: A) => void | Promise<void>,
) {
  return (ctx: Context, config: T | Volatile<unknown>, ...args: A): void | Promise<void> => {
    // Direct domain tests and programmatic consumers can supply already materialized configuration.
    if (!isVolatile(config)) return activate(ctx, config as T, ...args)
    const owner = configEntry(ctx)
    let current: Fiber | undefined
    let last = config.get()
    let stopped = false
    let queue = Promise.resolve()
    const mount = (value: unknown): Fiber =>
      ctx.plugin(
        {
          Config: schema,
          apply: (child: Context, resolved: T) => {
            if (owner) owners.set(child.fiber, owner)
            child.effect(
              () => () => {
                owners.delete(child.fiber)
              },
              'plugin-runtime: configuration owner',
            )
            return activate(child, resolved, ...args)
          },
        },
        structuredClone(value),
      )
    current = mount(last)
    const settings = ctx.get('settings')
    if (settings)
      ctx.effect(
        () => settings.configure({ auto: false }, ctx.fiber),
        'plugin-runtime: custom configuration page',
      )
    const reload = () => {
      queue = queue
        .then(async () => {
          if (stopped) return
          const next = config.get()
          if (next === last) return
          await current?.dispose()
          if (stopped) return
          last = next
          current = mount(next)
          await current.await()
        })
        .catch((error) => {
          ctx.logger.error(error)
        })
    }
    ctx.on('settings/document-updated', (namespace) => {
      if (owner && String(namespace) === owner.id) reload()
    })
    ctx.on('app-boot/config-reload', reload)
    ctx.effect(
      () => async () => {
        stopped = true
        await queue
        await current?.dispose()
      },
      'plugin-runtime: capability lifetime',
    )
    return current.await().then(() => {})
  }
}

/** An absent or blank optional value inherits its deployment default. */
export function optionalString(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

export { registerAuthorization } from './auth.ts'
export { brokerFetch } from './broker-fetch.ts'
export { abortable } from './cancellation.ts'
export { credentialStore, credentialValue } from './credential-scope.ts'
export { collectNativeText } from './native-text.ts'
export { PluginState, readPrivateState, registerPrivateStateReader } from './private-state.ts'
export * from './quota.ts'
export * from './quota-wire.ts'
export { getPiUserAgent, PI_ORIGINATOR } from './request-identity.ts'
export * from './reset-ledger.ts'
export {
  ProjectShellExecutor,
  registerShellRule,
  type ShellBudgets,
  type ShellRule,
} from './shell-routing.ts'
export { registerStatus } from './status.ts'
