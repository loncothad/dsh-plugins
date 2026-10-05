import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-config-editor'
import { pluginEntryId } from '@deepseek-ai/dsh-host-plugin-inventory'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { fingerprint } from '@loncothad/dsh-execution-core'
import { editableConfig, managedApply } from '@loncothad/dsh-plugin-runtime'
import { schema } from './config.ts'
import { changePreset, presetRows } from './presets.ts'
import { disabledSkillsSchema } from './skill-selection.ts'
import { maskSkills } from './skills.ts'
import { contribution, viewSchema } from './wire.ts'

export const name = 'builtin-controls'
export const inject = ['typert']
export const Config = editableConfig(schema)
const controlPageModules = new Set([
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-slots',
])
const mount = managedApply(schema, async (ctx: Context, input: { disabledSkills: string[] }) => {
  const disabled = disabledSkillsSchema.parse(input.disabledSkills)
  ctx.inject(['agents', 'skills'], async (scope) => {
    await maskSkills(scope, disabled)
  })
})
const label = (module: string) =>
  module
    .replace(/^@deepseek-ai\/(?:dsh-)?/, '')
    .replaceAll('-', ' ')
    .replace(/^./, (c) => c.toUpperCase())
export function apply(ctx: Context, input: Parameters<typeof mount>[1]) {
  ctx.inject(['tools'], (scope) =>
    scope.tools.guard((exec) => {
      if (exec.name !== 'skill') return
      try {
        const raw = typeof input === 'object' && input && 'get' in input ? input.get() : input,
          disabled = disabledSkillsSchema.parse(
            (raw as { disabledSkills?: unknown }).disabledSkills ?? [],
          ),
          skill = (exec.arguments as { name?: unknown }).name
        if (typeof skill === 'string' && disabled.includes(skill))
          return `Skill ${skill} is disabled in this profile.`
      } catch {
        return 'Skill controls are unavailable. Correct their configuration before loading skills.'
      }
    }),
  )
  let busy = false
  const editor = () => {
    const found = ctx.get('configEditor')
    if (!found) throw Error('This profile does not expose persistent configuration editing')
    return found
  }
  class Controls extends TypertRemoteService {
    constructor() {
      super(ctx, 'builtinControls')
      ctx.typert.register({
        package: contribution.package,
        face: 'host',
        model: { services: [], events: [], objects: [] },
        schemas: [],
        invocations: contribution.descriptors,
      })
    }
    private human() {
      if (!this.ctx.invocation) throw Error('Controls require the authenticated human Gateway')
    }
    private async mutate(run: () => Promise<string>) {
      this.human()
      if (busy) throw Error('Another component change is applying. Wait and refresh.')
      busy = true
      try {
        return await run()
      } finally {
        busy = false
      }
    }
    async read(catalog: string) {
      this.human()
      const manager = ctx.get('pluginManager'),
        configuration = ctx.get('configEditor')?.configuration() ?? [],
        native = (await manager?.listPlugins()) ?? [],
        compositions = (await ctx.get('agentPresets')?.compositionInventory()) ?? [],
        presets = configuration.filter(
          ({ entry }) => entry.options.name === '@deepseek-ai/dsh-agent-preset',
        ),
        agent = catalog === 'host' ? undefined : ctx.get('agents')?.get(SessionId(catalog))
      if (catalog !== 'host' && !agent)
        throw Error('This chat is no longer open. Choose another catalog.')
      const skills = (await ctx.get('skills')?.snapshot({
        scope: agent,
        cwd: agent?.session.header.cwd,
        signal: AbortSignal.timeout(10000),
      })) ?? { skills: [], complete: false }
      const result = {
        runtime: native
          .filter((row) => row.moduleName.startsWith('@deepseek-ai/'))
          .map((row) => ({
            id: row.entryId,
            module: row.moduleName,
            label:
              typeof row.meta?.title === 'string'
                ? row.meta.title
                : (row.meta?.title?.en ?? label(row.moduleName)),
            enabled: row.enabled,
            phase: row.fiberPhase,
            ...(row.readOnlyReason || (row.enabled && controlPageModules.has(row.moduleName))
              ? {
                  reason: controlPageModules.has(row.moduleName)
                    ? 'Required for this control page'
                    : row.readOnlyReason === 'management-required'
                      ? 'Required for host management'
                      : 'No unique profile control',
                }
              : {}),
            revision: fingerprint(row),
          })),
        presets: presets.map(({ entry }) => {
          const config = entry.options.config as Record<string, unknown>
          return {
            id: String(config.id),
            label: typeof config.name === 'string' ? config.name : String(config.id),
            entry: entry.id,
            revision: fingerprint(config),
            rows: presetRows(config.plugins).map((row) => {
              const live = compositions
                .find((p) => p.id === config.id)
                ?.rows.find(
                  (r) =>
                    r.moduleName === row.module &&
                    (r.entryId === row.label || r.entryId?.endsWith(`:${row.label}`)),
                )
              const title = ctx.baseUrl
                ? ctx.get('pluginPackages')?.metaOf(row.module, ctx.baseUrl)?.title
                : undefined
              return {
                ...row,
                title: typeof title === 'string' ? title : (title?.en ?? label(row.module)),
                enabled:
                  live?.enabled ??
                  (row.parentDisabled || row.ownDisabled
                    ? false
                    : row.conditional
                      ? 'conditional'
                      : true),
              }
            }),
          }
        }),
        chats: (ctx.get('agents')?.list() ?? []).slice(0, 256).map((a) => ({
          id: a.id,
          label: `${basename(a.session.header.cwd ?? 'Chat')} · ${a.id.slice(0, 8)}`,
        })),
        skills: skills.skills.map((s) => ({
          name: s.name,
          description: s.description.slice(0, 4096),
          source: s.source,
          provider: s.provider,
          modelInvocable: s.invocation.modelInvocable,
          userInvocable: s.invocation.userInvocable,
          disabled: s.provider === 'builtin-controls-disabled',
        })),
        skillsComplete: skills.complete,
      }
      const text = JSON.stringify(viewSchema.parse(result))
      if (text.length > 262144)
        throw Error('Control catalog exceeds 256 KiB. Reduce registered components.')
      return text
    }
    async changeRuntime(id: string, enabled: string, revision: string) {
      return this.mutate(async () => {
        if (enabled !== 'true' && enabled !== 'false') throw Error('Invalid enabled value')
        const manager = ctx.get('pluginManager')
        if (!manager) throw Error('Native plugin management is unavailable')
        const row = (await manager.listPlugins()).find((row) => row.entryId === id)
        if (!row?.moduleName.startsWith('@deepseek-ai/') || fingerprint(row) !== revision)
          throw Error('Component changed elsewhere. Refresh first.')
        if (enabled === 'false' && controlPageModules.has(row.moduleName))
          throw Error('This component is required for the control page. Its switch is locked here.')
        const result = await manager.setPluginEnabled(pluginEntryId(id), enabled === 'true')
        if (result.error || result.application === 'failed')
          throw Error(
            `Native component change failed: ${result.error?.code ?? 'application failed'}`,
          )
        return result.application === 'applied'
          ? 'Applied to this profile.'
          : result.application === 'restart-required'
            ? 'Saved. Restart DSH to apply.'
            : result.application === 'overridden'
              ? 'Saved, but another configuration overrides this choice.'
              : 'The change was cancelled.'
      })
    }
    async changePreset(entryId: string, path: string, mode: string, revision: string) {
      return this.mutate(async () => {
        if (!['on', 'off', 'default'].includes(mode)) throw Error('Invalid component choice')
        const configEditor = editor(),
          entry = configEditor.entries().find((e) => e.id === entryId)
        if (entry?.options.name !== '@deepseek-ai/dsh-agent-preset')
          throw Error('Preset configuration is unavailable')
        let before: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined
        await configEditor.edit(entry, (current, inherited) => {
          before = current
          next = changePreset(current, inherited, path, mode as 'on' | 'off' | 'default', revision)
          return next
        })
        try {
          await ctx.get('agentPresets')?.resolve(String(next!.id))
        } catch {
          await configEditor.edit(entry, (current) => {
            if (fingerprint(current) !== fingerprint(next))
              throw Error(
                'Activation failed and configuration changed again. Inspect this preset before continuing.',
              )
            return before!
          })
          throw Error(
            'The changed preset could not activate. The previous configuration was restored.',
          )
        }
        return 'Saved for new or resumed chats. Running chats keep their current preset revision.'
      })
    }
  }
  new Controls()
  return mount(ctx, input)
}
