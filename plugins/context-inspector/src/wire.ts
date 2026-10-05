import type {
  RemoteResult,
  TypertCodec,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
export const viewSchema = z
  .object({
    available: z.boolean(),
    capturedAt: z.string().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    contextWindow: z.number().nullable(),
    maxOutputTokens: z.number().nullable(),
    requestTokens: z.number().nullable(),
    estimateKind: z.string(),
    envelopeHeuristic: z.number().nullable(),
    messageCount: z.number(),
    omittedMessages: z.number(),
    tools: z.array(z.string()).max(1024),
    messages: z
      .array(
        z.object({
          role: z.string(),
          blocks: z.array(z.string()).max(64),
          characters: z.number(),
          preview: z.string().max(16384).optional(),
        }),
      )
      .max(256),
    retention: z
      .array(
        z.object({
          id: z.string(),
          kind: z.string(),
          seqs: z.array(z.number()).max(256),
          mandatory: z.boolean(),
          closed: z.boolean(),
          importance: z.number().nullable(),
          reasons: z.array(z.string()).max(32),
        }),
      )
      .max(256),
    prunedRanges: z
      .array(z.object({ seqs: z.array(z.number()).max(256), tokens: z.number() }))
      .max(64),
    environment: z.string(),
    evidenceState: z.string(),
    summaryVisibility: z.literal(
      'External summaries are private presentation references and excluded from request messages and evidence compaction.',
    ),
  })
  .strict()
export type InspectorView = z.infer<typeof viewSchema>
export interface InspectorRemote {
  read(sessionId: string): Promise<RemoteResult<InspectorView>>
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    contextInspector: InspectorRemote
  }
}
const result: TypertCodec = {
  mode: 'strict',
  typeSymbol: '@loncothad/dsh-context-inspector/wire#InspectorView',
  create: () => ({ parse: (value) => viewSchema.parse(value) }),
}
const id: TypertCodec = {
  mode: 'strict',
  typeSymbol: '@loncothad/dsh-context-inspector/wire#SessionId',
  create: () => ({
    parse(value: unknown) {
      if (typeof value !== 'string' || !value || value.length > 128)
        throw new Error('Invalid session identity')
      return value
    },
  }),
}
export const contribution: TypertRemoteContribution = {
  package: '@loncothad/dsh-context-inspector.control',
  descriptors: [
    {
      id: 'contextInspector/read',
      namespace: 'contextInspector',
      service: 'contextInspector',
      method: 'read',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: id }],
      result,
    },
  ],
}
