import type {
  RemoteResult,
  TypertCodec,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
export interface PluginStatusView {
  ready: boolean
  message: string
  fields: { label: string; value: string }[]
}
export interface PluginStatusRemote {
  state(): Promise<RemoteResult<PluginStatusView>>
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    [key: `pluginStatus_${string}`]: PluginStatusRemote
  }
}
export function parsePluginStatus(value: unknown): PluginStatusView {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid plugin status')
  const row = value as Record<string, unknown>
  if (
    typeof row.ready !== 'boolean' ||
    typeof row.message !== 'string' ||
    row.message.length > 4096 ||
    !Array.isArray(row.fields) ||
    row.fields.length > 64
  )
    throw new Error('Invalid plugin status')
  const fields = row.fields.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid status field')
    const field = value as Record<string, unknown>
    if (
      typeof field.label !== 'string' ||
      field.label.length > 256 ||
      typeof field.value !== 'string' ||
      field.value.length > 4096
    )
      throw new Error('Invalid status field')
    return { label: field.label, value: field.value }
  })
  return { ready: row.ready, message: row.message, fields }
}
export function statusContribution(id: string): TypertRemoteContribution {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(id)) throw new Error('Invalid status owner')
  const namespace = `pluginStatus_${id}`,
    result: TypertCodec = {
      mode: 'strict',
      typeSymbol: '@loncothad/dsh-plugin-runtime/status#PluginStatusView',
      create: () => ({ parse: parsePluginStatus }),
    }
  return {
    package: `@loncothad/dsh-plugin-runtime.status.${id}`,
    descriptors: [
      {
        id: `${namespace}/state`,
        namespace,
        service: namespace,
        method: 'state',
        invocation: { kind: 'direct' },
        parameters: [],
        result,
      },
    ],
  }
}
