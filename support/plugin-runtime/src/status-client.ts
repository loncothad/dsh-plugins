import type { Context } from '@deepseek-ai/cordis'
import { createElement as h, useEffect, useState } from 'react'
import { connectRemote, remoteValue } from './remote-client.ts'
import { type PluginStatusView, parsePluginStatus, statusContribution } from './status-wire.ts'
export function configurationStatus(ctx: Context, id: string): React.ComponentType {
  const read = connectRemote(ctx, `pluginStatus_${id}`, statusContribution(id))
  return function Status() {
    const [state, setState] = useState<PluginStatusView>(),
      [error, setError] = useState('')
    useEffect(() => {
      let live = true,
        pending = false
      const refresh = () => {
        if (pending) return
        pending = true
        void read()
          .then((remote) => remote.state())
          .then((result) => {
            if (live) {
              setState(parsePluginStatus(remoteValue(result)))
              setError('')
            }
          })
          .catch(() => {
            if (live)
              setError('Host readiness could not be loaded. Enable the capability and refresh.')
          })
          .finally(() => {
            pending = false
          })
      }
      refresh()
      const timer = setInterval(refresh, 3000)
      return () => {
        live = false
        clearInterval(timer)
      }
    }, [])
    return h(
      'section',
      { 'aria-label': 'Host readiness' },
      h('h3', null, 'Host readiness'),
      state
        ? h('p', { role: 'status' }, state.message)
        : h('p', { role: 'status' }, error || 'Loading readiness…'),
      state?.fields.length
        ? h(
            'dl',
            null,
            ...state.fields.flatMap((field) => [
              h('dt', { key: `${field.label}:label` }, field.label),
              h('dd', { key: `${field.label}:value` }, field.value),
            ]),
          )
        : null,
    )
  }
}
