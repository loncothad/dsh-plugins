import type { Context } from '@deepseek-ai/cordis'
import type {} from '@loncothad/dsh-execution-core'
/** Credential lookup must respect an installed immutable environment boundary, including catalog requests. */
export function credentialValue<T>(ctx: Context, read: () => T): T {
  const boundary = ctx.get('environmentIsolation')
  boundary?.assert()
  const identity = boundary?.identity
  const result = read()
  if (result instanceof Promise)
    return result.then((value) => {
      const current = ctx.get('environmentIsolation')
      current?.assert()
      if (boundary && (current !== boundary || current.identity !== identity))
        throw new Error('Credential environment changed during lookup')
      return value
    }) as T
  return result
}
/** Keep provider account stores private while guarding every adapter-owned method against scope changes. */
export function credentialStore<T extends object>(ctx: Context, store: T): T {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      return typeof value === 'function'
        ? (...args: unknown[]) => credentialValue(ctx, () => Reflect.apply(value, target, args))
        : value
    },
  })
}
