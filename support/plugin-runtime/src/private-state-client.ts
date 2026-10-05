import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useState } from 'react'
import type { PluginStateRemote } from './private-state-wire.ts'
import { privateStateContribution } from './private-state-wire.ts'
import { connectRemote, remoteValue } from './remote-client.ts'

const connections = new WeakMap<Context, Map<string, () => Promise<PluginStateRemote>>>()
/** One bounded authenticated read per active panel; late replies never update another session. */
export function privateStateObservation<T>(
  ctx: Context,
  channel: string,
  parse: (value: unknown) => T,
) {
  let channels = connections.get(ctx)
  if (!channels) {
    channels = new Map()
    connections.set(ctx, channels)
    ctx.effect(
      () => () => connections.delete(ctx),
      'private state client: release shared connections',
    )
  }
  let remote = channels.get(channel)
  if (!remote) {
    remote = connectRemote(ctx, `pluginState_${channel}`, privateStateContribution(channel))
    channels.set(channel, remote)
  }
  const readRemote = remote
  return function usePrivateState(sessionId: string) {
    const [state, setState] = useState<{
      sessionId: string
      status: 'loading' | 'ready' | 'unavailable'
      value?: T
    }>({ sessionId, status: 'loading' })
    useEffect(() => {
      let live = true,
        busy = false
      setState({ sessionId, status: 'loading' })
      const read = async () => {
        if (busy || !live) return
        busy = true
        try {
          const next = parse(JSON.parse(remoteValue(await (await readRemote()).read(sessionId))))
          if (live) {
            setState({ sessionId, status: 'ready', value: next })
          }
        } catch {
          if (live) {
            setState((previous) => ({
              sessionId,
              status: 'unavailable',
              value: previous.sessionId === sessionId ? previous.value : undefined,
            }))
          }
        } finally {
          busy = false
        }
      }
      void read()
      const timer = setInterval(() => {
        void read()
      }, 1500)
      return () => {
        live = false
        clearInterval(timer)
      }
    }, [sessionId])
    return state.sessionId === sessionId
      ? state
      : { sessionId, status: 'loading' as const, value: undefined }
  }
}

export function privateStateClient<T>(ctx: Context, channel: string, parse: (value: unknown) => T) {
  const observe = privateStateObservation(ctx, channel, parse)
  return (sessionId: string) => {
    const state = observe(sessionId)
    return state.status === 'ready' ? state.value : undefined
  }
}
