import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Authorization from '@deepseek-ai/dsh-authorization'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { CredentialProvider, credentialKey } from '@deepseek-ai/dsh-credentials'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { expect, it, vi } from 'vitest'
import { PluginAuthorization } from '../src/auth.ts'
import { type AuthView, parseAuthView } from '../src/auth-wire.ts'

class MemoryCredentials extends CredentialProvider {
  private records = new Map<CredentialKey, CredentialRecord>()
  async resolve() {
    return undefined
  }
  async describe() {
    return { configured: false, writable: true }
  }
  async set() {}
  async unset() {}
  async readRecord(key: CredentialKey) {
    return this.records.get(key)
  }
  async describeRecord(key: CredentialKey) {
    const record = this.records.get(key)
    return { configured: !!record, writable: true, ...(record ? { kind: record.kind } : {}) }
  }
  async listRecords() {
    return [...this.records].map(([key, record]) => ({ key, kind: record.kind }))
  }
  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ) {
    const next = await mutate(this.records.get(key))
    if (next) {
      this.records.set(key, next)
      this.ctx.emit('credentials/record-updated', key)
    }
    return next
  }
  async deleteRecord(key: CredentialKey) {
    this.records.delete(key)
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(Authorization)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(Gateway)
  const key = credentialKey('probe', 'login-flow')
  ctx.authorization.registerFlow({
    key,
    label: 'Probe',
    methods: [{ id: 'device', label: 'Device login' }],
    run: async (session) => {
      const answer = await session.prompt({ kind: 'secret', message: 'Credential' })
      session.notify({ message: 'Approval received.' })
      await session.commit({ kind: 'grant', payload: { token: answer } })
    },
  })
  new PluginAuthorization(ctx, key, 'codexAuth')
  const makePeer = (name: string): PeerScope => {
    const scope = new Context()
    ctx.effect(() => () => scope.fiber.dispose())
    return { id: name as PeerId, ctx: scope, dispose: () => scope.fiber.dispose() }
  }
  const peer = makePeer('owner')
  const call = async (
    method: string,
    args: Record<string, unknown> = {},
    caller = peer,
  ): Promise<AuthView> =>
    parseAuthView(
      await ctx.typertGateway.invoke({ namespace: 'codexAuth', method, args, peer: caller }),
    )
  return { ctx, key, call, peer, makePeer }
}

it('authorizes through real Gateway descriptors without exposing the submitted secret', async () => {
  const { ctx, key, call } = await setup()
  try {
    await expect(call('begin', { method: 'unsupported' })).rejects.toThrow('Unsupported')
    const begin = await call('begin', { method: 'device' })
    let state = begin
    await vi.waitFor(async () => {
      state = await call('state')
      expect(state.attempt?.prompt).toBeDefined()
    })
    await expect(
      call('answer', { attemptId: begin.attempt!.id, promptId: 'stale', value: 'secret-key' }),
    ).rejects.toThrow('no longer active')
    await call('answer', {
      attemptId: begin.attempt!.id,
      promptId: state.attempt!.prompt!.id,
      value: 'secret-key',
    })
    await vi.waitFor(async () => expect((await call('state')).attempt?.status).toBe('authorized'))
    expect(await ctx.credentials.readRecord(key)).toEqual({
      kind: 'grant',
      payload: { token: 'secret-key' },
    })
    expect(JSON.stringify(await call('state'))).not.toContain('secret-key')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('isolates attempts between admitted Peers and cancels pending prompts on disconnect', async () => {
  const { ctx, call, peer, makePeer } = await setup()
  try {
    const begin = await call('begin', { method: 'device' })
    const other = makePeer('other')
    expect(await call('state', {}, other)).not.toHaveProperty('attempt')
    await expect(call('cancel', { attemptId: begin.attempt!.id }, other)).rejects.toThrow(
      'unavailable',
    )
    await peer.dispose()
    await vi.waitFor(async () => expect((await call('state')).attempt?.status).toBe('cancelled'))
  } finally {
    await ctx.fiber.dispose()
  }
})

it('rejects unsafe authorization URLs at the shared boundary', () => {
  expect(() =>
    parseAuthView({
      methods: [],
      attempt: {
        id: '1',
        status: 'running',
        notice: { message: 'go', url: 'javascript:alert(1)' },
      },
    }),
  ).toThrow('link')
})
