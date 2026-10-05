import type {
  RemoteResult,
  TypertCodec,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
export interface SummaryContentRemote {
  read(sessionId: string, reference: string): Promise<RemoteResult<string>>
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    conversationSummaryContent: SummaryContentRemote
  }
}
const bounded = (limit: number, symbol: string): TypertCodec => ({
  mode: 'strict',
  typeSymbol: symbol,
  create: () => ({
    parse(value: unknown) {
      if (typeof value !== 'string' || !value || value.length > limit)
        throw new Error('Invalid summary content request')
      return value
    },
  }),
})
export const contentContribution: TypertRemoteContribution = {
  package: '@loncothad/dsh-conversation-summary.content',
  descriptors: [
    {
      id: 'conversationSummaryContent/read',
      namespace: 'conversationSummaryContent',
      service: 'conversationSummaryContent',
      method: 'read',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'sessionId',
          wire: 'sessionId',
          source: 'json',
          codec: bounded(128, '@loncothad/dsh-conversation-summary/content#SessionId'),
        },
        {
          name: 'reference',
          wire: 'reference',
          source: 'json',
          codec: bounded(64, '@loncothad/dsh-conversation-summary/content#Reference'),
        },
      ],
      result: bounded(65536, '@loncothad/dsh-conversation-summary/content#Content'),
    },
  ],
}
