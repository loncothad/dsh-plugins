import { spawn } from 'node:child_process'
import { abortable } from '@loncothad/dsh-plugin-runtime'
import type { Policy, SecretReference } from './config.ts'
export interface ProviderInternals {
  fetch?: typeof fetch
  run?: (
    executable: string,
    args: string[],
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
    maxBytes: number,
  ) => Promise<string>
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
}
const script =
  "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $value=Get-Secret -Name $env:DSH_SECRET_NAME -Vault $env:DSH_SECRET_VAULT -AsPlainText; if($value -isnot [string]){throw 'Expected string secret'}; [Console]::Out.Write($value)"
async function run(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0,
      stderrSize = 0,
      settled = false
    const chunks: Buffer[] = []
    const child = spawn(executable, args, {
      shell: false,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const cleanup = () => signal.removeEventListener('abort', abort),
      fail = () => {
        if (settled) return
        settled = true
        cleanup()
        child.kill()
        reject(new Error('Secret provider retrieval failed'))
      },
      abort = () => fail()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      fail()
      return
    }
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        fail()
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length
      if (stderrSize > 65536) fail()
    }) // No stderr content enters diagnostics.
    child.on('error', fail)
    child.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      if (code !== 0) reject(new Error('Secret provider retrieval failed'))
      else {
        try {
          resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
        } catch {
          reject(new Error('Secret provider returned invalid UTF-8'))
        }
      }
    })
  })
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid secret locator')
  return value as Record<string, unknown>
}
function baseEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {}
  for (const name of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
  ])
    if (source[name]) selected[name] = source[name]
  return selected
}
async function body(response: Response, signal: AbortSignal, limit: number): Promise<string> {
  if (!response.body) throw new Error('Secret provider returned no body')
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await abortable(reader.read(), signal)
      if (next.done) break
      bytes += next.value.length
      if (bytes > limit) throw new Error('Secret provider response exceeds its limit')
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}
/** Fixed public provider protocols; callers never supply executable code or arbitrary shell arguments. */
export async function readSecret(
  policy: Policy,
  reference: SecretReference,
  signal: AbortSignal,
  internals: ProviderInternals = {},
): Promise<string> {
  const platform = internals.platform ?? process.platform,
    source = internals.environment ?? process.env
  if (platform !== 'linux' && platform !== 'win32')
    throw new Error('Secrets Broker supports Linux and Windows')
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(policy.providerTimeoutMs)]),
    execute = internals.run ?? run,
    environment = baseEnvironment(source)
  let value: string
  if (reference.provider === 'vault') {
    const address = new URL(policy.vaultAddress)
    if (
      address.protocol !== 'https:' ||
      address.username ||
      address.password ||
      address.search ||
      address.hash
    )
      throw new Error('Vault requires a configured HTTPS address')
    const locator = object(JSON.parse(reference.locator)),
      mount = String(locator.mount ?? ''),
      path = String(locator.path ?? ''),
      field = String(locator.field ?? '')
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(mount) ||
      !path ||
      path
        .split('/')
        .some(
          (part) => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(part),
        ) ||
      !field ||
      field.length > 256
    )
      throw new Error('Invalid Vault KV v2 locator')
    const token = source[`DSH_SECRET_${reference.environment.toUpperCase()}_VAULT_TOKEN`]
    if (!token) throw new Error('No environment-scoped Vault bootstrap credential')
    const url = new URL(
      `/v1/${encodeURIComponent(mount)}/data/${path.split('/').map(encodeURIComponent).join('/')}`,
      address,
    )
    const response = await abortable(
      (internals.fetch ?? fetch)(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'X-Vault-Token': token,
          ...(policy.vaultNamespace ? { 'X-Vault-Namespace': policy.vaultNamespace } : {}),
        },
        signal: deadline,
      }),
      deadline,
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('Vault secret retrieval failed')
    }
    const payload = object(JSON.parse(await body(response, deadline, 262144))),
      data = object(object(payload.data).data)
    if (typeof data[field] !== 'string')
      throw new Error('The selected Vault field is not a string secret')
    value = data[field] as string
  } else if (reference.provider === 'onepassword') {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Deliberate control-character filtering at an input or log boundary.
    if (!reference.locator.startsWith('op://') || /[\u0000-\u001f]/.test(reference.locator))
      throw new Error('Use a 1Password secret reference URI')
    const token = source[`DSH_SECRET_${reference.environment.toUpperCase()}_OP_TOKEN`]
    if (token) environment.OP_SERVICE_ACCOUNT_TOKEN = token
    value = await execute(
      policy.onePasswordExecutable,
      ['read', '--no-newline', reference.locator],
      environment,
      deadline,
      policy.maxSecretBytes,
    )
  } else if (reference.provider === 'secret-service') {
    if (platform !== 'linux') throw new Error('Secret Service requires a Linux host')
    const locator = object(JSON.parse(reference.locator))
    if (
      Object.keys(locator).length > 16 ||
      Object.entries(locator).some(
        ([key, value]) =>
          !key || typeof value !== 'string' || key.length > 128 || value.length > 1024,
      )
    )
      throw new Error('Invalid Secret Service attributes')
    if (locator.environment !== undefined && locator.environment !== reference.environment)
      throw new Error('Secret Service environment mismatch')
    value = (
      await execute(
        policy.secretToolExecutable,
        [
          'lookup',
          ...Object.entries({ ...locator, environment: reference.environment }).flatMap(
            ([key, value]) => [key, String(value)],
          ),
        ],
        environment,
        deadline,
        policy.maxSecretBytes + 2,
      )
    ).replace(/\r?\n$/, '')
  } else {
    if (platform !== 'win32') throw new Error('SecretManagement requires a Windows host')
    const locator = object(JSON.parse(reference.locator))
    if (
      typeof locator.vault !== 'string' ||
      typeof locator.name !== 'string' ||
      !locator.vault ||
      !locator.name ||
      locator.vault.length > 1024 ||
      locator.name.length > 1024
    )
      throw new Error('Invalid SecretManagement locator')
    environment.DSH_SECRET_NAME = locator.name
    environment.DSH_SECRET_VAULT = locator.vault
    value = await execute(
      policy.powershellExecutable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      environment,
      deadline,
      policy.maxSecretBytes,
    )
  }
  deadline.throwIfAborted()
  if (
    !value ||
    Buffer.byteLength(value, 'utf8') > policy.maxSecretBytes ||
    Buffer.from(value, 'utf8').toString('utf8') !== value
  )
    throw new Error('Secret value is unavailable or outside its bounds')
  return value
}
