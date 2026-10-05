/** Installed native account adapters; credentials are read only on the Host. */

import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { QualificationBudget, qualificationDirectory } from './budget.mjs'

const [consumerArg, homeArg, runId] = process.argv.slice(2)
if (!consumerArg || !homeArg || !/^[a-z0-9-]{1,64}$/.test(runId ?? ''))
  throw new Error(
    'Usage: node tests/live/accounts.mjs INSTALLED_CONSUMER PRIVATE_DSH_HOME UNIQUE_RUN_ID',
  )
if (!process.env.DSH_CODEX_TEST_MODEL || !process.env.DSH_ZAI_TEST_MODEL)
  throw Error('Set DSH_CODEX_TEST_MODEL and DSH_ZAI_TEST_MODEL to account-supported models')
const require = createRequire(join(resolve(consumerArg), 'package.json')),
  load = async (name) => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis'),
  { default: Credentials } = await load('@deepseek-ai/dsh-credentials-local'),
  { CodexAdapter, accountStoreOf } = await load('@loncothad/dsh-provider-openai-codex'),
  { createZaiProviders, zaiStoreOf } = await load('@loncothad/dsh-provider-zai')
const { default: LlmRuntime, BlockAssembler } = await load('@deepseek-ai/dsh-llm')
const { readMediaResponse } = await load('@loncothad/dsh-media-gen')
const errors = []
const inspect = async (url, init) => {
  const response = await fetch(url, init)
  if (!response.ok) {
    const text = new TextDecoder().decode(
      await readMediaResponse(response.clone(), 65536, init?.signal ?? AbortSignal.timeout(20000)),
    )
    const auth = new Headers(init?.headers).get('authorization')?.replace(/^(Bearer|Key) /, '')
    let message
    try {
      const body = JSON.parse(text)
      message = body.error?.message ?? body.detail ?? body.message
    } catch {}
    if (typeof message === 'string') {
      if (auth) message = message.replaceAll(auth, '[redacted]')
      errors.push({ status: response.status, message: message.slice(0, 512) })
    }
  }
  return response
}
const ctx = new Context(),
  directory = qualificationDirectory(),
  budget = await QualificationBudget.open(directory),
  results = []
try {
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Credentials, { dshHome: resolve(homeArg), watch: false })
  const store = accountStoreOf(ctx.get('credentials')),
    zaiStore = zaiStoreOf(ctx.get('credentials'))
  const providers = [
    {
      name: 'codex',
      model: process.env.DSH_CODEX_TEST_MODEL,
      maximumUsd: Number(process.env.DSH_CODEX_TEST_RESERVE_USD),
      adapter: new CodexAdapter({ store, fetch: inspect, timeoutMs: 60000 }),
    },
    {
      name: 'zai',
      model: process.env.DSH_ZAI_TEST_MODEL,
      maximumUsd: Number(process.env.DSH_ZAI_TEST_RESERVE_USD),
      adapter: createZaiProviders({
        store: () => zaiStore.read(),
        apiKey: () => undefined,
        codingCnApiKey: () => undefined,
        timeoutMs: 60000,
      }).zai,
    },
  ]
  for (const provider of providers) ctx.llm.registerAdapter([provider.name], provider.adapter)
  for (const provider of providers) {
    const present =
      provider.name === 'codex'
        ? Boolean(await store.activeAccount())
        : Boolean(await zaiStore.read())
    if (!present) {
      results.push({
        provider: provider.name,
        passed: false,
        reason: 'No operator-configured grant',
      })
      continue
    }
    // Codex has no wire output cap. The operator's explicit worst-case quote
    // must cover the selected model; the deadline is not a billing limit.
    const reservation = await budget.reserve(`${runId}-${provider.name}`, provider.maximumUsd),
      started = performance.now()
    let finish,
      textBytes = 0,
      usage
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of ctx.llm.stream({
        provider: provider.name,
        model: provider.model,
        ...(provider.name === 'zai'
          ? { maxTokens: 32, reasoningEffort: 'low' }
          : { reasoningEffort: 'low' }),
        system: 'Answer the test prompt briefly. Do not call any tools.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply only OK.' }] }],
        tools: [],
        signal: AbortSignal.timeout(20000),
      })) {
        assembler.push(chunk)
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') finish = chunk.reason
      }
      textBytes = assembler
        .blocks()
        .filter((block) => block.type === 'text')
        .reduce((sum, block) => sum + Buffer.byteLength(block.text), 0)
      const row = {
        provider: provider.name,
        model: provider.model,
        passed: Boolean(finish && finish.kind === 'stop' && textBytes > 0),
        finish: finish?.kind ?? null,
        ...(finish?.kind === 'error'
          ? { failure: { code: finish.failure.code, status: finish.failure.status ?? null } }
          : {}),
        textBytes,
        usage: usage ?? null,
        latencyMs: performance.now() - started,
        billedUsd: null,
      }
      results.push(row)
      await budget.complete(reservation, row)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const row = {
        provider: provider.name,
        model: provider.model,
        passed: false,
        reason: /refresh_token_invalidated/.test(message)
          ? 'Provider rejected refresh token as invalidated'
          : (/HTTP \d+/.exec(message)?.[0] ?? 'Native adapter request failed'),
        latencyMs: performance.now() - started,
        billedUsd: null,
      }
      results.push(row)
      await budget.complete(reservation, row)
    }
  }
  await mkdir('.qualification/accounts', { recursive: true })
  const report = {
    checkedAt: new Date().toISOString(),
    runId,
    results,
    errors,
    reservedUsd: budget.reservedUsd,
    limitations: [
      'Z.AI uses 32 output tokens. Codex has no output-cap parameter. Reservations are explicit operator quotes for the selected models; the 20-second deadline is not a billing cap.',
      'Unknown billing retains the full spending reservation.',
      'No unsupported removal of the output cap or unbounded retry is performed.',
    ],
  }
  await writeFile(`.qualification/accounts/${runId}.json`, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  if (results.some((row) => !row.passed)) process.exitCode = 1
} finally {
  await ctx.fiber.dispose()
  await budget.close()
}
