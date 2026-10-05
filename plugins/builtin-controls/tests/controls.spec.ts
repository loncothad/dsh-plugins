import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import Registry from '@deepseek-ai/dsh-typert-registry'
import { fingerprint } from '@loncothad/dsh-execution-core'
import { expect, it } from 'vitest'
import { apply } from '../src/index.ts'

it('uses human Gateway controls, rejects stale writes and restores failed preset activation without returning configs', async () => {
  const ctx = new Context(),
    peerCtx = new Context(),
    peer = {
      id: 'operator' as import('@deepseek-ai/dsh-typert-protocol').PeerId,
      ctx: peerCtx,
      dispose: () => peerCtx.fiber.dispose(),
    },
    entry = {
      id: 'include:preset-standard',
      options: {
        name: '@deepseek-ai/dsh-agent-preset',
        config: {
          id: 'standard',
          plugins: [
            {
              id: 'tool-fs',
              name: '@deepseek-ai/dsh-tool-fs',
              config: { secret: 'fixture-private-config' },
            },
          ],
        },
      },
    },
    inherited = structuredClone(entry.options.config),
    runtime = [
      {
        entryId: 'include:example',
        moduleName: '@deepseek-ai/dsh-example',
        enabled: true,
        fiberPhase: 'active',
        patchId: 'example',
      },
    ],
    calls: boolean[] = []
  let edits = 0
  try {
    await ctx.plugin(Registry)
    await ctx.plugin(Gateway)
    const skills = ctx.plugin(SkillRegistry)
    await skills.await()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('agents', { list: () => [], get: () => undefined } as never)
    ctx.provide('pluginManager', {
      listPlugins: async () => runtime,
      setPluginEnabled: async (_id: string, enabled: boolean) => {
        calls.push(enabled)
        runtime[0].enabled = enabled
        return { application: 'applied' }
      },
    } as never)
    ctx.provide('configEditor', {
      entries: () => [entry],
      configuration: () => [{ entry, inherited, override: {} }],
      edit: async (
        _entry: unknown,
        change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => unknown,
      ) => {
        edits++
        entry.options.config = change(
          entry.options.config,
          inherited,
        ) as typeof entry.options.config
      },
    } as never)
    ctx.provide('agentPresets', {
      compositionInventory: async () => [],
      resolve: async () => {
        if ((entry.options.config.plugins[0] as { disabled?: boolean }).disabled)
          throw Error('Missing filesystem')
      },
    } as never)
    const settings = { disabledSkills: [] as string[] }
    await apply(ctx, settings)
    let loaded = 0
    ctx.tools.register(
      defineTool({
        name: 'skill',
        description: 'Direct invocation fixture',
        parameters: { name: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        execute: async () => {
          loaded++
          return 'Loaded'
        },
      }),
    )
    settings.disabledSkills.push('blocked-skill')
    const result = await ctx.tools.execute({
      name: 'skill',
      callId: ToolCallId('direct'),
      arguments: { name: 'blocked-skill' },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(loaded).toBe(0)
    settings.disabledSkills = []
    const call = async (method: string, args: Record<string, string>) =>
      ctx.typertGateway.invoke({ namespace: 'builtinControls', method, args, peer })
    const view = JSON.parse((await call('read', { catalog: 'host' })) as string)
    expect(JSON.stringify(view)).not.toContain('fixture-private-config')
    expect(view.presets[0].rows[0].module).toBe('@deepseek-ai/dsh-tool-fs')
    await expect(
      call('changeRuntime', { id: runtime[0].entryId, enabled: 'false', revision: 'stale' }),
    ).rejects.toThrow('changed elsewhere')
    expect(calls).toEqual([])
    await call('changeRuntime', {
      id: runtime[0].entryId,
      enabled: 'false',
      revision: fingerprint(runtime[0]),
    })
    expect(calls).toEqual([false])
    await expect(
      call('changePreset', {
        entry: entry.id,
        path: '0',
        mode: 'off',
        revision: fingerprint(entry.options.config),
      }),
    ).rejects.toThrow('previous configuration was restored')
    expect(edits).toBe(2)
    expect(entry.options.config).toEqual(inherited)
    await skills.dispose()
    const withoutSkills = JSON.parse((await call('read', { catalog: 'host' })) as string)
    expect(withoutSkills.runtime).toHaveLength(1)
    expect(withoutSkills.skillsComplete).toBe(false)
    await expect(call('read', { catalog: 'unopened-chat' })).rejects.toThrow('no longer open')
  } finally {
    await peerCtx.fiber.dispose()
    await ctx.fiber.dispose()
  }
})
