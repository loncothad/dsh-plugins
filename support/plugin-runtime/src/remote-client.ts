/** Native Gateway namespaces need scoped injection and outcome decoding in every custom control. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {
  RemoteResult,
  TypertRemoteContribution,
  TypertRemoteNamespaceMap,
} from '@deepseek-ai/dsh-typert-protocol'
export function remoteValue<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
export function connectRemote<K extends Extract<keyof TypertRemoteNamespaceMap, string>>(
  ctx: Context,
  namespace: K,
  contribution: TypertRemoteContribution,
): () => Promise<TypertRemoteNamespaceMap[K]> {
  let mounted: Promise<TypertRemoteNamespaceMap[K]> | undefined
  return () =>
    (mounted ??= ctx.remote
      .$mount(contribution)
      .then(
        () =>
          new Promise<TypertRemoteNamespaceMap[K]>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('Provider control connection timed out')),
              15000,
            )
            ctx.inject([`remote.${namespace}`], (scope) => {
              clearTimeout(timer)
              resolve(scope.remote[namespace])
            })
            ctx.effect(
              () => () => {
                clearTimeout(timer)
                reject(new Error('Provider control disposed'))
              },
              'plugin control: remote readiness',
            )
          }),
      )
      .catch((error) => {
        mounted = undefined
        throw error
      }))
}
