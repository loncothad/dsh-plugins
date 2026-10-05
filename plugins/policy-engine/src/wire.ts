import type {
  RemoteResult,
  TypertCodec,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
export const permissionsViewSchema = z
  .object({
    grants: z
      .array(
        z
          .object({
            id: z.string(),
            label: z.string(),
            workspace: z.string(),
            expiresAt: z.number(),
          })
          .strict(),
      )
      .max(32),
    pending: z
      .array(
        z
          .object({
            callId: z.string(),
            requestHash: z.string(),
            label: z.string(),
            workspace: z.string(),
            canRemember: z.boolean(),
          })
          .strict(),
      )
      .max(128),
  })
  .strict()
export type PermissionsView = z.infer<typeof permissionsViewSchema>
export interface PolicyPermissionsRemote {
  read(sessionId: string): Promise<RemoteResult<string>>
  remember(sessionId: string, callId: string, requestHash: string): Promise<RemoteResult<string>>
  revoke(sessionId: string, id: string): Promise<RemoteResult<string>>
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    policyPermissions: PolicyPermissionsRemote
  }
}
const string: TypertCodec = {
  mode: 'strict',
  typeSymbol: '@loncothad/dsh-policy-engine/wire#String',
  create: () => ({
    parse: (v) => {
      if (typeof v !== 'string' || !v || v.length > 65536)
        throw Error('Invalid permission control input')
      return v
    },
  }),
}
export const contribution: TypertRemoteContribution = {
  package: '@loncothad/dsh-policy-engine.permissions',
  descriptors: [
    ['read', ['sessionId']],
    ['remember', ['sessionId', 'callId', 'requestHash']],
    ['revoke', ['sessionId', 'id']],
  ].map(([method, fields]) => ({
    id: `policyPermissions/${method}`,
    namespace: 'policyPermissions',
    service: 'policyPermissions',
    method: method as string,
    invocation: { kind: 'direct' },
    parameters: (fields as string[]).map((name) => ({
      name,
      wire: name,
      source: 'json',
      codec: string,
    })),
    result: string,
  })),
}
