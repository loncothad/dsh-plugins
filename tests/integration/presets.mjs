/** Activate and restart complete shipped presets using installed tarballs and registry DSH only. No paid calls. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

if (!process.argv[2]) throw Error('Usage: node tests/integration/presets.mjs INSTALLED_CONSUMER')
const consumer = resolve(process.argv[2])
const require = createRequire(join(consumer, 'package.json'))
const load = async (name) => import(pathToFileURL(require.resolve(name)).href)
const plugin = async (name) => {
  const module = await load(name)
  return module.default ?? module
}
const { Context } = await load('@deepseek-ai/cordis')
const { default: Loader, Group } = await load('@deepseek-ai/cordis-plugin-loader')
const { loadOverlayPatches, initProfile, mountRootInclude, readProfilePatches } = await load(
  '@deepseek-ai/dsh-app-boot',
)
const { LlmAdapter, createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { replacePresetCompaction, installPresetCompaction } = await load(
  '@loncothad/dsh-evidence-harness',
)
const { EvidenceCompactorManager, EvidenceCompactionEngine, Config } = await load(
  '@loncothad/dsh-evidence-compactor',
)
const { default: Schema } = await load('@deepseek-ai/schemastery')
const configSchema = new Schema(Config.toJSON())
delete configSchema.meta.volatile
const home = await mkdtemp(join(tmpdir(), 'dsh-packed-presets-')),
  dir = join(home, 'profile'),
  bundle = join(dir, 'node_modules', 'preset-fixture')
initProfile(dir, ['preset-fixture'])
await mkdir(bundle, { recursive: true })
await writeFile(join(home, 'package.json'), '{"name":"packed-preset-qualification"}')
await writeFile(
  join(bundle, 'package.json'),
  JSON.stringify({
    name: 'preset-fixture',
    version: '1.0.0',
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }),
)
const webRoot = dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json'))
const definitions = ['standard', 'ptc'].map((name) => {
  const row = loadOverlayPatches('qualification', join(webRoot, 'presets', `${name}.patch.yml`))
    .flatMap((patch) => patch.insert ?? [])
    .find((row) => row.id === `preset-${name}`)
  assert.ok(row?.config)
  return { id: `preset-${name}`, name: '@deepseek-ai/dsh-agent-preset', config: row.config }
})
await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: definitions }]))
await writeFile(join(dir, 'cordis.yml'), '[]\n')
const profile = {
  name: 'qualification',
  startedBundles: ['preset-fixture'],
  dir,
  patchPath: join(dir, 'cordis.patch.yml'),
  installAnchor: join(home, 'package.json'),
  cwd: home,
  home,
  overlays: [],
  telemetryDisabledEnv: undefined,
}
const start = async (enabled = true) => {
  const ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(home).href}/`
  try {
    for (const name of [
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-commands',
    ])
      await ctx.plugin(await plugin(name))
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
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
    ])
      await ctx.plugin(await plugin(name))
    await ctx.plugin(await plugin('@deepseek-ai/dsh-sandbox-policy'), {
      mode: 'workspace-write',
      workspaceRoot: home,
    })
    await ctx.plugin(
      await plugin(
        process.platform === 'win32'
          ? '@deepseek-ai/dsh-pwsh-sandbox'
          : '@deepseek-ai/dsh-bash-sandbox',
      ),
    )
    await ctx.plugin(await plugin('@deepseek-ai/dsh-ptc-runtime-node'))
    ctx.loader.internal = { version: 'v2', import: load }
    await ctx.plugin(await plugin('@deepseek-ai/dsh-session-query-sqlite'), {
      path: join(home, 'query.sqlite'),
      openAt: 'never',
    })
    await ctx.plugin(await plugin('@deepseek-ai/dsh-token-meter'))
    if (enabled)
      new EvidenceCompactorManager(
        ctx,
        configSchema({
          dataDir: join(home, 'archive'),
          installOnEnable: false,
          archiveEnabled: false,
        }),
      )
    await ctx.plugin(await plugin('@deepseek-ai/dsh-agent-preset-registry'), {
      default: 'standard',
    })
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', {
      onReady(listener) {
        listener()
        return () => {}
      },
    })
    await ctx.plugin(await plugin('@deepseek-ai/dsh-config-editor'))
    await mountRootInclude(ctx, join(dir, 'cordis.yml'), readProfilePatches('dsh', profile))
    await ctx.loader.await()
    return ctx
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
class Provider extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 128000 },
      defaultMaxTokens: 4096,
    }
  }
  async *stream(request) {
    this.requests.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'Packed preset continuation completed.' },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
let ctx
try {
  ctx = await start()
  assert.deepEqual(
    await installPresetCompaction(ctx.configEditor, ['preset-standard', 'preset-ptc']),
    ['preset-standard', 'preset-ptc'],
  )
  await ctx.fiber.dispose()
  ctx = await start()
  assert.ok((await ctx.agentPresets.list()).every((row) => !row.broken))
  const persisted = await readFile(profile.patchPath, 'utf8')
  assert.ok(persisted.includes('@loncothad/dsh-evidence-compactor/runtime'))
  assert.ok(!persisted.includes('@deepseek-ai/dsh-compaction-basic'))
  await ctx.plugin(await plugin('@deepseek-ai/dsh-agent-loop'), { agents: [] })
  const provider = new Provider()
  ctx.llm.registerAdapter(['qualification'], provider)
  for (const name of ['standard', 'ptc']) {
    const handle = await ctx.agents.create({
      sessionId: `packed-${name}`,
      agentOptions: { provider: 'qualification', model: 'fixture' },
      meta: { cwd: home, agentPreset: name },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, name)
      },
    })
    assert.ok(
      ctx.agentPresets.serviceFor(handle.agent, 'compaction') instanceof EvidenceCompactionEngine,
    )
    handle.agent.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Continue without publication approval.' }],
      }),
    )
    await handle.agent.whenIdle()
  }
  assert.equal(provider.requests.length, 2)
  for (const row of ctx.configEditor
    .configuration()
    .filter((row) => row.entry.options.id.startsWith('preset-'))) {
    const original = definitions.find((item) => item.id === row.entry.options.id)
    assert.deepEqual(row.entry.options.config, replacePresetCompaction(original.config).config)
  }
  await ctx.fiber.dispose()
  ctx = await start(false)
  assert.equal(ctx.get('evidenceCompactor'), undefined)
  assert.ok((await ctx.agentPresets.list()).every((row) => !row.broken))
  await ctx.plugin(await plugin('@deepseek-ai/dsh-agent-loop'), { agents: [] })
  const disabledProvider = new Provider()
  ctx.llm.registerAdapter(['qualification'], disabledProvider)
  for (const name of ['standard', 'ptc']) {
    const handle = await ctx.agents.create({
      sessionId: `packed-disabled-${name}`,
      agentOptions: { provider: 'qualification', model: 'fixture' },
      meta: { cwd: home, agentPreset: name },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, name)
      },
    })
    assert.ok(
      ctx.agentPresets.serviceFor(handle.agent, 'compaction') instanceof EvidenceCompactionEngine,
    )
    assert.ok(ctx.commands.find(handle.agent, 'compact'))
    handle.agent.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Continue while evidence compaction remains disabled.' }],
      }),
    )
    await handle.agent.whenIdle()
  }
  assert.equal(disabledProvider.requests.length, 2)
  const report = {
    node: process.version,
    platform: process.platform,
    installedOnly: true,
    sourceAliases: false,
    presetHealth: ['standard', 'ptc'],
    restart: true,
    disabledRestartPresetHealth: ['standard', 'ptc'],
    disabledNativeAgentTurns: disabledProvider.requests.length,
    controlledNativeAgentTurns: provider.requests.length,
    paidCalls: 0,
  }
  await mkdir('.qualification/packed-presets', { recursive: true })
  await writeFile(
    '.qualification/packed-presets/qualification.json',
    `${JSON.stringify(report, null, 2)}\n`,
  )
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (ctx) await ctx.fiber.dispose()
}
