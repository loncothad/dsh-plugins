import type {
  RemoteResult,
  TypertCodec,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

const row = z.object({
  id: z.string(),
  module: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  phase: z.string().nullable(),
  reason: z.string().optional(),
  revision: z.string(),
})
export const viewSchema = z.object({
  runtime: z.array(row).max(2048),
  presets: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        entry: z.string(),
        revision: z.string(),
        reason: z.string().optional(),
        rows: z
          .array(
            z.object({
              path: z.string(),
              module: z.string(),
              label: z.string(),
              title: z.string().optional(),
              ownDisabled: z.boolean(),
              conditional: z.boolean(),
              parentDisabled: z.boolean(),
              enabled: z.union([z.boolean(), z.literal('conditional')]),
            }),
          )
          .max(512),
      }),
    )
    .max(64),
  chats: z.array(z.object({ id: z.string(), label: z.string() })).max(256),
  skills: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        provider: z.string(),
        source: z.string(),
        modelInvocable: z.boolean(),
        userInvocable: z.boolean(),
        disabled: z.boolean(),
      }),
    )
    .max(1024),
  skillsComplete: z.boolean(),
})
export type ControlsView = z.infer<typeof viewSchema>
export interface ControlsRemote {
  read(catalog: string): Promise<RemoteResult<string>>
  changeRuntime(id: string, enabled: string, revision: string): Promise<RemoteResult<string>>
  changePreset(
    entry: string,
    path: string,
    mode: string,
    revision: string,
  ): Promise<RemoteResult<string>>
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    builtinControls: ControlsRemote
  }
}
const string: TypertCodec = {
  mode: 'strict',
  typeSymbol: '@loncothad/dsh-builtin-controls/wire#String',
  create: () => ({
    parse(value: unknown) {
      if (typeof value !== 'string' || !value || value.length > 262144)
        throw Error('Invalid control value')
      return value
    },
  }),
}
export const contribution: TypertRemoteContribution = {
  package: '@loncothad/dsh-builtin-controls.control',
  descriptors: [
    ['read', ['catalog']],
    ['changeRuntime', ['id', 'enabled', 'revision']],
    ['changePreset', ['entry', 'path', 'mode', 'revision']],
  ].map(([method, fields]) => ({
    id: `builtinControls/${method}`,
    namespace: 'builtinControls',
    service: 'builtinControls',
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
