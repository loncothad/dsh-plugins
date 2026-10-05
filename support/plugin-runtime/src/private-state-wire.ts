import type {
  RemoteResult,
  TypertCodec,
  TypertRemoteContribution,
  TypertRemoteNamespaceMap,
} from '@deepseek-ai/dsh-typert-protocol'
export interface PluginStateRemote {
  read(sessionId: string): Promise<RemoteResult<string>>
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    [key: `pluginState_${string}`]: PluginStateRemote
  }
}
const string = (max: number, name: string): TypertCodec => ({
  mode: 'strict',
  typeSymbol: `@loncothad/dsh-plugin-runtime#${name}`,
  create: () => ({
    parse(value: unknown) {
      if (typeof value !== 'string' || !value || value.length > max)
        throw new Error('Invalid private state request')
      return value
    },
  }),
})
export function privateStateContribution(channel: string): TypertRemoteContribution {
  const namespace = `pluginState_${channel}` as keyof TypertRemoteNamespaceMap
  return {
    package: `@loncothad/dsh-plugin-runtime.private-state-${channel}`,
    descriptors: [
      {
        id: `${namespace}/read`,
        namespace,
        service: namespace,
        method: 'read',
        invocation: { kind: 'direct' },
        parameters: [
          { name: 'sessionId', wire: 'sessionId', source: 'json', codec: string(128, 'SessionId') },
        ],
        result: string(131072, 'StateJson'),
      },
    ],
  }
}
