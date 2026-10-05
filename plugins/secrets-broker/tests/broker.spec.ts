import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { brokerFetch } from '@loncothad/dsh-plugin-runtime'
import { afterEach, expect, it, vi } from 'vitest'
import { type Policy, type SecretReference, schema } from '../src/config.ts'
import { apply, readSecret } from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
})
const reference: SecretReference = {
  id: 'provider-key',
  environment: 'dev',
  provider: 'onepassword',
  locator: 'op://dev/provider/password',
  consumers: ['openrouter'],
}
async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(CommandRuntime)
  ctx.provide('environmentIsolation', {
    identity: 'dev-generation',
    environment: 'dev',
    valid: true,
    reason: 'controlled verified fixture',
    scope: (id) => `dev/${id}`,
    assert() {},
  })
  const run = vi.fn(async () => 'private-provider-key')
  await apply(
    ctx,
    { references: [reference] },
    {
      platform: 'linux',
      environment: {
        PATH: '/trusted',
        DSH_SECRET_DEV_OP_TOKEN: 'private-bootstrap',
        DSH_SECRET_PROD_OP_TOKEN: 'must-not-copy',
        OPENROUTER_API_KEY: 'must-not-copy',
      },
      run,
    },
  )
  return { ctx, run }
}
it('borrows only authorized references and omits unrelated host credentials from CLI execution', async () => {
  const f = await fixture()
  const value = await f.ctx.secretsBroker.withCredentials(
    'openrouter',
    'session',
    ['provider-key'],
    new AbortController().signal,
    async (values) => {
      expect(Object.isFrozen(values)).toBe(true)
      return values['provider-key']
    },
  )
  expect(value).toBe('private-provider-key')
  const [command, args, environment] = f.run.mock.calls[0] as unknown as [
    string,
    string[],
    NodeJS.ProcessEnv,
  ]
  expect(command).toBe('op')
  expect(args).toEqual(['read', '--no-newline', 'op://dev/provider/password'])
  expect(environment.OP_SERVICE_ACCOUNT_TOKEN).toBe('private-bootstrap')
  expect(environment.OPENROUTER_API_KEY).toBeUndefined()
  expect(environment.DSH_SECRET_PROD_OP_TOKEN).toBeUndefined()
  await expect(
    f.ctx.secretsBroker.withCredentials(
      'unapproved',
      'session',
      ['provider-key'],
      new AbortController().signal,
      async () => 'bad',
    ),
  ).rejects.toThrow('not authorized')
  expect(f.ctx.secretsBroker.redact('private-provider-key')).toBe('[redacted]')
})
it('uses the documented Vault KV v2 envelope and the matching environment bootstrap token', async () => {
  const policy = schema({ vaultAddress: 'https://vault.example' }) as Policy
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ data: { data: { key: 'vault-value' }, metadata: { version: 2 } } }),
        { status: 200 },
      ),
  )
  const value = await readSecret(
    policy,
    {
      ...reference,
      provider: 'vault',
      locator: JSON.stringify({ mount: 'secret', path: 'dev/provider', field: 'key' }),
    },
    new AbortController().signal,
    {
      platform: 'linux',
      environment: {
        DSH_SECRET_DEV_VAULT_TOKEN: 'dev-token',
        DSH_SECRET_PROD_VAULT_TOKEN: 'prod-token',
      },
      fetch,
    },
  )
  expect(value).toBe('vault-value')
  const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
  expect(url.href).toBe('https://vault.example/v1/secret/data/dev/provider')
  expect(new Headers(init.headers).get('X-Vault-Token')).toBe('dev-token')
})
it('passes Windows vault locators as values without executable interpolation', async () => {
  const policy = schema({}) as Policy,
    run = vi.fn(async () => 'windows-value'),
    name = "name'; Write-Host injected; '"
  const value = await readSecret(
    policy,
    {
      ...reference,
      provider: 'secretmanagement',
      locator: JSON.stringify({ vault: 'CredMan', name }),
    },
    new AbortController().signal,
    { platform: 'win32', environment: { SystemRoot: 'C:\\Windows' }, run },
  )
  expect(value).toBe('windows-value')
  const [, args, environment] = run.mock.calls[0] as unknown as [
    string,
    string[],
    NodeJS.ProcessEnv,
  ]
  const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le')
  expect(script).not.toContain(name)
  expect(script).toContain('$env:DSH_SECRET_NAME')
  expect(environment.DSH_SECRET_NAME).toBe(name)
})
it('binds Linux Secret Service attributes to the declared environment', async () => {
  const policy = schema({}) as Policy,
    run = vi.fn(async () => 'linux-value\n')
  expect(
    await readSecret(
      policy,
      {
        ...reference,
        provider: 'secret-service',
        locator: '{"application":"dsh","name":"provider"}',
      },
      new AbortController().signal,
      { platform: 'linux', run },
    ),
  ).toBe('linux-value')
  expect((run.mock.calls[0] as unknown as [string, string[]])[1]).toContain('dev')
  await expect(
    readSecret(
      policy,
      { ...reference, provider: 'secret-service', locator: '{"environment":"prod"}' },
      new AbortController().signal,
      { platform: 'linux', run },
    ),
  ).rejects.toThrow('mismatch')
})
it('rejects cancelled operations and prevents a deployment generation change from returning borrowed values', async () => {
  const f = await fixture(),
    controller = new AbortController()
  let began!: () => void
  const started = new Promise<void>((resolve) => {
    began = resolve
  })
  const pending = f.ctx.secretsBroker.withCredentials(
    'openrouter',
    'session',
    ['provider-key'],
    controller.signal,
    async () => {
      began()
      return new Promise<string>(() => {})
    },
  )
  await started
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
  await expect(
    f.ctx.secretsBroker.withCredentials(
      'openrouter',
      'session',
      ['provider-key'],
      new AbortController().signal,
      async () => {
        f.ctx.environmentIsolation.identity = 'changed'
        return 'private-provider-key'
      },
    ),
  ).rejects.toThrow('failed')
})
it('injects a key only into approved API requests and keeps provider failure bodies out of diagnostics', async () => {
  const f = await fixture(),
    transport = vi.fn(async () => new Response('private-provider-key', { status: 401 }))
  const fetch = brokerFetch(f.ctx, {
    consumer: 'openrouter',
    reference: () => 'provider-key',
    origins: ['https://openrouter.ai'],
    scheme: 'Bearer',
    fetch: transport,
  })
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    headers: { authorization: 'Bearer broker-managed' },
  })
  expect(
    new Headers((transport.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get(
      'authorization',
    ),
  ).toBe('Bearer private-provider-key')
  expect(await response.text()).not.toContain('private-provider-key')
  await fetch('https://cdn.example/result', { headers: { authorization: 'Bearer broker-managed' } })
  expect(
    new Headers((transport.mock.calls[1] as unknown as [string, RequestInit])[1].headers).has(
      'authorization',
    ),
  ).toBe(false)
})
