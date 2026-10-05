import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import {
  initProfile,
  loadOverlayPatches,
  mountRootInclude,
  type ProfileContext,
  readProfilePatches,
} from '@deepseek-ai/dsh-app-boot'
import * as CompactCommand from '@deepseek-ai/dsh-command-compact'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { installPresetCompaction, replacePresetCompaction } from '@loncothad/dsh-evidence-harness'
import { afterEach, expect, it } from 'vitest'
import type { Config } from '../src/config.ts'
import { BaseConfig } from '../src/config.ts'
import { EvidenceCompactorManager } from '../src/manager.ts'
import EvidenceCompactionEngine from '../src/runtime.ts'

const contexts: Context[] = [],
  dirs: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const harnessRoot = resolve(
  process.env.DSH_SOURCE_DIR ?? join(root, '../external/deepseek-harness'),
)
function shipped(name: 'standard' | 'ptc'): Record<string, unknown> {
  const patches = loadOverlayPatches(
    'evidence-test',
    join(harnessRoot, 'packages/bundle/web-app/presets', `${name}.patch.yml`),
  )
  const row = patches
    .flatMap((patch) => patch.insert ?? [])
    .find((row) => row.id === `preset-${name}`)
  if (!row?.config || typeof row.config !== 'object' || Array.isArray(row.config))
    throw new Error('Shipped preset definition is absent')
  return row.config as Record<string, unknown>
}
class Provider extends LlmAdapter {
  requests: GenerateOptions[] = []
  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 28000 },
      defaultMaxTokens: 8000,
    }
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'text',
        text:
          this.requests.length === 1
            ? 'An old failed observation remains unapproved. '.repeat(650)
            : 'Continuing safely.',
      },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('transforms the actual standard and PTC presets while preserving every unrelated row and expression', () => {
  for (const name of ['standard', 'ptc'] as const) {
    const original = shipped(name),
      transformed = replacePresetCompaction(original)
    const before = original.plugins as EntryOptions[],
      after = transformed.config.plugins as EntryOptions[]
    expect(after.filter((row) => row.id !== 'compaction')).toEqual(
      before.filter((row) => row.id !== 'compaction'),
    )
    const group = after.find((row) => row.id === 'compaction')!
    expect(group.isolate).toEqual(before.find((row) => row.id === 'compaction')!.isolate)
    expect((group.config as EntryOptions[]).map((row) => row.name)).toEqual([
      '@loncothad/dsh-evidence-compactor/runtime',
      '@deepseek-ai/dsh-command-compact',
    ])
    expect(replacePresetCompaction(transformed.config).changed).toBe(false)
  }
})

it.each(['standard', 'ptc'] as const)(
  'loads the shipped %s compaction group through the real preset registry and drives native request rebuilding',
  async (name) => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-evidence-preset-'))
    dirs.push(dir)
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = `${pathToFileURL(dir).href}/`
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    await ctx.plugin(SqliteSessionQueryEngine, { path: join(dir, 'query.sqlite'), openAt: 'never' })
    await ctx.plugin(TokenMeter)
    const options = BaseConfig({
      dataDir: join(dir, 'archive'),
      installOnEnable: false,
      archiveEnabled: false,
      safetyTokens: 500,
      toolResultReserve: 1000,
    }) as Config
    new EvidenceCompactorManager(ctx, options, {
      workerUrl: new URL('../../../support/evidence-store/lib/worker.js', import.meta.url),
    })
    const imports: string[] = []
    ctx.loader.internal = {
      version: 'v2',
      async import(name: string) {
        imports.push(name)
        if (name === '@loncothad/dsh-evidence-compactor/runtime')
          return { default: EvidenceCompactionEngine }
        if (name === '@deepseek-ai/dsh-command-compact') return CompactCommand
        throw new Error(`Unexpected backend import: ${name}`)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.plugin(AgentPresetRegistry, { default: name })
    const transformed = replacePresetCompaction(shipped(name)).config
    const compaction = (transformed.plugins as EntryOptions[]).find(
      (row) => row.id === 'compaction',
    )!
    await ctx.agentPresets.register({ id: name, plugins: [compaction] })
    expect((await ctx.agentPresets.list())[0]?.broken).toBeUndefined()
    await ctx.plugin(AgentLoop, { agents: [] })
    const provider = new Provider()
    ctx.llm.registerAdapter(['fixture'], provider)
    const handle = await ctx.agents.create({
      sessionId: SessionId(`preset-evidence-${name}`),
      agentOptions: { provider: 'fixture', model: 'main' },
      meta: { cwd: dir, agentPreset: name },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, name)
      },
    })
    const agent = handle.agent
    expect(ctx.agentPresets.serviceFor(agent, 'compaction')).toBeInstanceOf(
      EvidenceCompactionEngine,
    )
    expect(ctx.get('compaction')).toBeUndefined()
    expect(ctx.get('toolResultPruner')).toBeUndefined()
    expect(imports).not.toContain('@deepseek-ai/dsh-compaction-basic')
    expect(imports).not.toContain('@deepseek-ai/dsh-compaction-tool-result-pruner')
    agent.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Original unapproved task evidence. '.repeat(700) }],
      }),
    )
    await agent.whenIdle()
    agent.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Continue investigating without approval.' }],
      }),
    )
    await agent.whenIdle()
    const log = await ctx.sessionQuery.readSession(agent.session.id)
    expect(log.events.some((event) => event.type === 'compaction/summary')).toBe(true)
    expect(provider.requests).toHaveLength(2)
    expect(ctx.commands.find(agent, 'compact')).toBeDefined()
  },
)

it('persists complete preset replacements, verifies full preset health, and runs restored agents after restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-persisted-presets-'))
  dirs.push(home)
  const dir = join(home, 'profile'),
    bundle = join(dir, 'node_modules', 'preset-fixture')
  initProfile(dir, ['preset-fixture'])
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"preset-installation"}')
  await writeFile(
    join(bundle, 'package.json'),
    JSON.stringify({
      name: 'preset-fixture',
      version: '1.0.0',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }),
  )
  const definitions = ['standard', 'ptc'].map((name) => ({
    id: `preset-${name}`,
    name: '@deepseek-ai/dsh-agent-preset',
    config: shipped(name as 'standard' | 'ptc'),
  }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: definitions }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'fixture',
    startedBundles: ['preset-fixture'],
    dir,
    patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'),
    cwd: home,
    home,
    overlays: [],
    telemetryDisabledEnv: undefined,
  }
  const start = async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = `${pathToFileURL(home).href}/`
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(Loader)
    for (const name of [
      '@deepseek-ai/dsh-subprocess-local',
      '@deepseek-ai/dsh-fs-local',
      '@deepseek-ai/dsh-sandbox-local',
      '@deepseek-ai/dsh-shell-env',
      '@deepseek-ai/dsh-jobs-local',
      '@deepseek-ai/dsh-goal',
      '@deepseek-ai/dsh-user-questions',
      '@deepseek-ai/dsh-skill',
      '@deepseek-ai/dsh-web',
      '@deepseek-ai/dsh-subagent',
      '@deepseek-ai/dsh-tool-subagent/model-selection-settings',
    ]) {
      const module = await import(name)
      await ctx.plugin(module.default ?? module)
    }
    const policy = await import('@deepseek-ai/dsh-sandbox-policy')
    await ctx.plugin(policy.default, { mode: 'workspace-write', workspaceRoot: home })
    const shell = await import(
      process.platform === 'win32'
        ? '@deepseek-ai/dsh-pwsh-sandbox'
        : '@deepseek-ai/dsh-bash-sandbox'
    )
    await ctx.plugin(shell.default)
    const ptc = await import('@deepseek-ai/dsh-ptc-runtime-node')
    await ctx.plugin(ptc.default)
    ctx.loader.builtins.group = Group
    ctx.loader.internal = {
      version: 'v2',
      async import(name: string) {
        if (name === '@deepseek-ai/dsh-agent-preset') return { default: AgentPreset }
        if (name === '@loncothad/dsh-evidence-compactor/runtime')
          return { default: EvidenceCompactionEngine }
        return import(name)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.plugin(SqliteSessionQueryEngine, {
      path: join(home, 'query.sqlite'),
      openAt: 'never',
    })
    await ctx.plugin(TokenMeter)
    new EvidenceCompactorManager(
      ctx,
      BaseConfig({
        dataDir: join(home, 'archive'),
        installOnEnable: false,
        archiveEnabled: false,
      }) as Config,
      { workerUrl: new URL('../../../support/evidence-store/lib/worker.js', import.meta.url) },
    )
    await ctx.plugin(AgentPresetRegistry, { default: 'standard' })
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', {
      onReady: (listener: () => void) => {
        listener()
        return () => {}
      },
    })
    await ctx.plugin(ConfigEditor)
    await mountRootInclude(ctx, join(dir, 'cordis.yml'), readProfilePatches('dsh', profile))
    await ctx.loader.await()
    return ctx
  }
  let ctx = await start()
  expect(
    await installPresetCompaction(ctx.configEditor, ['preset-standard', 'preset-ptc']),
  ).toEqual(['preset-standard', 'preset-ptc'])
  const health = await ctx.agentPresets.list()
  expect(health.map((row) => ({ id: row.id, broken: row.broken }))).toEqual([
    { id: 'standard', broken: undefined },
    { id: 'ptc', broken: undefined },
  ])
  const persisted = await readFile(profile.patchPath, 'utf8')
  expect(persisted).toContain('@loncothad/dsh-evidence-compactor/runtime')
  expect(persisted).not.toContain('@deepseek-ai/dsh-compaction-basic')
  expect(
    ctx.configEditor
      .configuration()
      .filter((row) => row.entry.options.id.startsWith('preset-'))
      .map((row) => row.entry.options.id)
      .sort(),
  ).toEqual(['preset-ptc', 'preset-standard'])
  for (const row of ctx.configEditor
    .configuration()
    .filter((row) => row.entry.options.id.startsWith('preset-'))) {
    const name = row.entry.options.id.slice(7) as 'standard' | 'ptc'
    expect(row.entry.options.config).toEqual(replacePresetCompaction(shipped(name)).config)
  }
  expect(
    await installPresetCompaction(ctx.configEditor, ['preset-standard', 'preset-ptc']),
  ).toEqual([])
  await ctx.fiber.dispose()
  ctx = await start()
  expect((await ctx.agentPresets.list()).every((row) => row.broken === undefined)).toBe(true)
  await ctx.plugin(AgentLoop, { agents: [] })
  const provider = new Provider()
  provider.resolveModel = async (route, model) => ({
    provider: route,
    id: model,
    name: model,
    context: { contextWindow: 128000 },
    defaultMaxTokens: 4096,
  })
  ctx.llm.registerAdapter(['fixture'], provider)
  for (const name of ['standard', 'ptc']) {
    const handle = await ctx.agents.create({
      sessionId: SessionId(`full-profile-${name}`),
      agentOptions: { provider: 'fixture', model: 'main' },
      meta: { cwd: home, agentPreset: name },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, name)
      },
    })
    expect(ctx.agentPresets.serviceFor(handle.agent, 'compaction')).toBeInstanceOf(
      EvidenceCompactionEngine,
    )
    handle.agent.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Continue safely with the installed preset.' }],
      }),
    )
    await handle.agent.whenIdle()
  }
  expect(provider.requests).toHaveLength(2)
  expect(
    ctx.configEditor
      .configuration()
      .filter((row) => row.entry.options.id.startsWith('preset-'))
      .map((row) => row.entry.options.id)
      .sort(),
  ).toEqual(['preset-ptc', 'preset-standard'])
  for (const row of ctx.configEditor
    .configuration()
    .filter((row) => row.entry.options.id.startsWith('preset-'))) {
    const name = row.entry.options.id.slice(7) as 'standard' | 'ptc'
    expect(row.entry.options.config).toEqual(replacePresetCompaction(shipped(name)).config)
  }
}, 30000)
