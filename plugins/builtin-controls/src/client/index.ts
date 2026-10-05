import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import {
  configurationTheme,
  connectRemote,
  remoteValue,
} from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { disabledSkillsSchema } from '../skill-selection.ts'
import { type ControlsView, contribution, viewSchema } from '../wire.ts'

export const inject = ['slots', 'locale', 'remote', 'configForms']
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'builtin-controls': keyof typeof copy
  }
}
const copy = {
  controls: 'Controls',
  runtime: 'Runtime components',
  presets: 'Agent presets',
  skills: 'Skills',
  search: 'Search names and modules',
  refresh: 'Refresh',
  loading: 'Loading controls…',
  empty: 'No matching components.',
  enabled: 'On',
  disabled: 'Off',
  conditional: 'Conditional',
  restore: 'Restore default',
  catalog: 'Skill catalog for',
  host: 'Host catalog',
  applying: 'Applying change…',
  skillSaved: 'Skill choice saved for this profile.',
  profile:
    'Runtime switches apply to this host profile. Protected management components stay enabled.',
  presetHelp:
    'Preset changes apply to new or resumed chats. Running chats retain their current revision. Enabling a conditional row overrides its condition; Restore default restores the inherited setting.',
  skillHelp:
    'Skill switches apply to future model and human loading in this profile, including open chats. Already loaded instructions remain in conversation history. These switches do not disable the tools mentioned by a skill.',
  partial: 'Some skill providers did not finish discovery. Refresh before relying on this list.',
  sourceDisabled: 'Disabled by this profile',
  parentDisabled: 'Disabled or conditional parent group',
  readOnly: 'Skill configuration is unavailable or read-only in this profile.',
}
const zh: typeof copy = {
  controls: '控制',
  runtime: '运行组件',
  presets: '代理预设',
  skills: '技能',
  search: '搜索名称和模块',
  refresh: '刷新',
  loading: '正在加载控制项…',
  empty: '没有匹配项。',
  enabled: '开启',
  disabled: '关闭',
  conditional: '条件控制',
  restore: '恢复默认',
  catalog: '技能目录来源',
  host: '主机目录',
  applying: '正在应用…',
  skillSaved: '已保存此配置文件的技能选择。',
  profile: '运行开关应用于当前主机配置文件。管理所需的组件无法关闭。',
  presetHelp:
    '预设更改应用于新建或恢复的会话。正在运行的会话保留当前版本。开启条件组件会覆盖其条件；恢复默认使用继承的设置。',
  skillHelp:
    '技能开关影响此配置文件中的后续模型和用户加载，包括已打开的会话。已加载的指令仍保留在历史记录中。此开关不会禁用技能提到的工具。',
  partial: '部分技能提供方未完成发现。请刷新后再使用此列表。',
  sourceDisabled: '被此配置文件禁用',
  parentDisabled: '父组被禁用或有条件限制',
  readOnly: '此配置文件的技能配置不可用或只读。',
}
type Tab = 'runtime' | 'presets' | 'skills'
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.locale.register('builtin-controls', { en: copy, zh }),
    'builtin-controls: copy',
  )
  const t = ctx.locale.bind('builtin-controls'),
    remote = connectRemote(ctx, 'builtinControls', contribution),
    form = ctx.configForms.get<{ disabledSkills: string[] }>('builtin-controls')
  function Page() {
    const pageId = useId()
    const settings = useSyncExternalStore(
        (f) => form.subscribe(f),
        () => form.getSnapshot(),
      ),
      [view, setView] = useState<ControlsView>(),
      [tab, setTab] = useState<Tab>('presets'),
      [search, setSearch] = useState(''),
      [catalog, setCatalog] = useState('host'),
      [busy, setBusy] = useState(false),
      [error, setError] = useState(''),
      [message, setMessage] = useState(''),
      [tick, setTick] = useState(0)
    const live = useRef(false),
      epoch = useRef(0),
      pending = useRef(false)
    useEffect(() => {
      live.current = true
      return () => {
        live.current = false
        epoch.current++
      }
    }, [])
    // biome-ignore lint/correctness/useExhaustiveDependencies: Saved revisions and explicit refreshes invalidate host catalogs even when the catalog selector is unchanged.
    useEffect(() => {
      const id = ++epoch.current
      setView(undefined)
      void remote()
        .then((r) => r.read(catalog))
        .then((value) => {
          if (live.current && epoch.current === id)
            setView(viewSchema.parse(JSON.parse(remoteValue(value))))
        })
        .catch((e) => {
          if (live.current && epoch.current === id)
            setError(e instanceof Error ? e.message : 'Could not load controls')
        })
      return () => {
        epoch.current++
      }
    }, [catalog, settings.revision, tick])
    const mutate = async (run: () => Promise<string>) => {
      if (pending.current) return
      pending.current = true
      setBusy(true)
      setError('')
      setMessage('')
      try {
        const text = await run()
        if (live.current) {
          setMessage(text)
          setTick((n) => n + 1)
        }
      } catch (e) {
        if (live.current) {
          setError(e instanceof Error ? e.message : 'Change failed')
          setTick((n) => n + 1)
        }
      } finally {
        pending.current = false
        if (live.current) setBusy(false)
      }
    }
    const skill = (name: string, enabled: boolean) =>
      mutate(async () => {
        if (settings.status !== 'ready' || !settings.writable) throw Error(t('readOnly'))
        const current = disabledSkillsSchema.parse(settings.value?.disabledSkills ?? []),
          next = enabled
            ? current.filter((s) => s !== name)
            : [...new Set([...current, name])].sort()
        const accepted = await form.mutate(
          [{ op: 'set', path: ['disabledSkills'], value: next }],
          settings.revision,
        )
        if (!accepted) throw Error('Skill choices changed elsewhere. Refresh first.')
        return t('skillSaved')
      })
    const matches = (...values: string[]) =>
      values.join(' ').toLowerCase().includes(search.trim().toLowerCase())
    const row = (
      id: string,
      title: string,
      detail: string,
      status: string,
      control: React.ReactNode,
      extra?: React.ReactNode,
    ) =>
      h(
        'article',
        { key: id, className: 'dsh-builtin-row' },
        h(
          'div',
          { className: 'dsh-builtin-description' },
          h('strong', null, title),
          h('p', null, detail),
          h('span', { className: 'dsh-builtin-state' }, status),
          extra,
        ),
        h('div', { className: 'dsh-builtin-actions' }, control),
      )
    const groups: React.ReactNode[] = []
    if (view && tab === 'runtime') {
      for (const r of view.runtime.filter((r) => matches(r.label, r.module, r.reason ?? ''))) {
        groups.push(
          row(
            r.id,
            r.label,
            r.module,
            r.reason ?? (r.enabled ? (r.phase ?? 'Waiting') : t('disabled')),
            h(Switch, {
              label: r.label,
              checked: r.enabled,
              disabled: busy || Boolean(r.reason),
              title: r.reason,
              onChange: (on: boolean) =>
                void mutate(async () =>
                  remoteValue(await (await remote()).changeRuntime(r.id, String(on), r.revision)),
                ),
            }),
          ),
        )
      }
    }
    if (view && tab === 'presets') {
      for (const p of view.presets) {
        const rows = p.rows.filter((r) => matches(p.label, r.title ?? '', r.label, r.module))
        if (!rows.length) continue
        groups.push(
          h(
            'section',
            { key: p.entry, className: 'dsh-builtin-group', 'aria-label': `${p.label} components` },
            h('h3', null, p.label),
            p.reason ? h('p', { role: 'status' }, p.reason) : null,
            ...rows.map((r) =>
              row(
                `${p.entry}/${r.path}`,
                r.title ?? r.label,
                `${r.module} · ${r.label}`,
                r.parentDisabled
                  ? t('parentDisabled')
                  : r.conditional
                    ? `${r.enabled === 'conditional' ? t('conditional') : r.enabled ? t('enabled') : t('disabled')} · ${t('conditional')}`
                    : !r.enabled
                      ? t('disabled')
                      : t('enabled'),
                h(
                  'div',
                  null,
                  h(Switch, {
                    label: `${p.label}: ${r.label}`,
                    checked: r.enabled === true,
                    disabled: busy || Boolean(p.reason) || r.parentDisabled,
                    onChange: (on: boolean) =>
                      void mutate(async () =>
                        remoteValue(
                          await (await remote()).changePreset(
                            p.entry,
                            r.path,
                            on ? 'on' : 'off',
                            p.revision,
                          ),
                        ),
                      ),
                  }),
                  h(
                    Button,
                    {
                      size: 'sm',
                      variant: 'outline',
                      disabled: busy || Boolean(p.reason) || r.parentDisabled,
                      onClick: () =>
                        void mutate(async () =>
                          remoteValue(
                            await (await remote()).changePreset(
                              p.entry,
                              r.path,
                              'default',
                              p.revision,
                            ),
                          ),
                        ),
                    },
                    t('restore'),
                  ),
                ),
              ),
            ),
          ),
        )
      }
    }
    if (view && tab === 'skills') {
      for (const s of view.skills.filter((s) =>
        matches(s.name, s.description, s.provider, s.source),
      )) {
        const disabled = (settings.value?.disabledSkills ?? []).includes(s.name)
        groups.push(
          row(
            s.name,
            s.name,
            s.description,
            s.disabled ? t('sourceDisabled') : `${s.source} · ${s.provider}`,
            h(Switch, {
              label: s.name,
              checked: !disabled && (s.modelInvocable || s.userInvocable),
              disabled:
                busy ||
                settings.status !== 'ready' ||
                !settings.writable ||
                (!s.disabled && !s.modelInvocable && !s.userInvocable),
              onChange: (on: boolean) => void skill(s.name, on),
            }),
          ),
        )
      }
    }
    return h(
      'section',
      {
        className: 'dsh-plugin-settings dsh-builtin-controls',
        'aria-label': 'Built-in controls',
        'aria-busy': busy,
      },
      h('style', null, configurationTheme + theme),
      h(
        'div',
        { className: 'dsh-builtin-tabs', role: 'tablist', 'aria-label': 'Control categories' },
        ...(['presets', 'runtime', 'skills'] as Tab[]).map((key, index, tabs) =>
          h(
            Button,
            {
              key,
              variant: 'outline',
              size: 'sm',
              role: 'tab',
              'aria-selected': tab === key,
              id: `${pageId}-tab-${key}`,
              'aria-controls': `${pageId}-panel-${key}`,
              tabIndex: tab === key ? 0 : -1,
              onClick: () => setTab(key),
              onKeyDown: (e: React.KeyboardEvent) => {
                const next =
                  e.key === 'ArrowRight'
                    ? (index + 1) % tabs.length
                    : e.key === 'ArrowLeft'
                      ? (index + tabs.length - 1) % tabs.length
                      : e.key === 'Home'
                        ? 0
                        : e.key === 'End'
                          ? tabs.length - 1
                          : undefined
                if (next === undefined) return
                e.preventDefault()
                setTab(tabs[next])
                e.currentTarget.parentElement
                  ?.querySelectorAll<HTMLButtonElement>('[role=tab]')
                  [next]?.focus()
              },
            },
            t(key),
          ),
        ),
      ),
      h(
        'p',
        null,
        t(tab === 'runtime' ? 'profile' : tab === 'presets' ? 'presetHelp' : 'skillHelp'),
      ),
      h(
        'div',
        { className: 'dsh-builtin-toolbar' },
        h(Input, {
          value: search,
          placeholder: t('search'),
          'aria-label': t('search'),
          style: { width: '100%' },
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value),
        }),
        h(
          Button,
          { variant: 'outline', size: 'sm', disabled: busy, onClick: () => setTick((n) => n + 1) },
          t('refresh'),
        ),
      ),
      tab === 'skills'
        ? h(
            'label',
            { className: 'dsh-builtin-catalog' },
            t('catalog'),
            h(
              'select',
              {
                value: catalog,
                disabled: busy,
                onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setCatalog(e.target.value),
              },
              h('option', { value: 'host' }, t('host')),
              ...(view?.chats ?? []).map((c) => h('option', { key: c.id, value: c.id }, c.label)),
            ),
          )
        : null,
      error ? h('p', { role: 'alert' }, error) : null,
      busy || message ? h('p', { role: 'status' }, busy ? t('applying') : message) : null,
      !view && !error ? h('p', { role: 'status' }, t('loading')) : null,
      view && tab === 'skills' && !view.skillsComplete
        ? h('p', { role: 'status' }, t('partial'))
        : null,
      h(
        'div',
        {
          id: `${pageId}-panel-${tab}`,
          role: 'tabpanel',
          'aria-labelledby': `${pageId}-tab-${tab}`,
        },
        ...groups,
        view && !groups.length ? h('p', null, t('empty')) : null,
      ),
    )
  }
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      { name: 'plugins.bundle.config', key: '@loncothad/dsh-builtin-controls' },
      Page,
    ),
  )
  ctx.slots.inject('plugins.row.config', () =>
    ctx.slots.register(
      { name: 'plugins.row.config', key: '@loncothad/dsh-builtin-controls#builtin-controls' },
      Page,
    ),
  )
  ctx.slots.inject('settings.plugins.tab', () =>
    ctx.slots.register(
      {
        name: 'settings.plugins.tab',
        id: 'builtin-controls',
        order: 10,
        label: () => t('controls'),
      },
      Page,
    ),
  )
}
const theme = `
.dsh-builtin-controls{width:100%;min-width:0;box-sizing:border-box;color:var(--dsw-alias-text-primary)}
.dsh-builtin-tabs,.dsh-builtin-toolbar{display:flex;align-items:center;gap:10px;margin:12px 0;flex-wrap:wrap}
.dsh-builtin-tabs [aria-selected=true]{background:var(--dsw-alias-bg-mild-hover);border-color:var(--dsw-alias-border-l3)}
.dsh-builtin-toolbar>:first-child{flex:1;min-width:180px;max-width:100%}
.dsh-builtin-group{margin:20px 0}.dsh-builtin-group h3{margin:0 0 10px;font-size:14px}
.dsh-builtin-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsh-builtin-description{min-width:0;flex:1;overflow-wrap:anywhere}.dsh-builtin-description p{font-size:12px;overflow-wrap:anywhere;margin:5px 0;color:var(--dsw-alias-text-secondary)}
.dsh-builtin-state{font-size:12px;color:var(--dsw-alias-text-tertiary)}.dsh-builtin-actions{flex-shrink:0}.dsh-builtin-actions>div{display:flex;align-items:center;gap:10px}
.dsh-builtin-catalog{display:flex!important;grid-template-columns:none!important;align-items:center;gap:10px;flex-wrap:wrap;margin:12px 0;min-width:0}.dsh-builtin-catalog select{min-width:0;max-width:100%;padding:7px 10px;background:var(--dsw-alias-bg-base);color:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
@media(max-width:560px){.dsh-builtin-row{align-items:flex-start;gap:10px}.dsh-builtin-actions>div{flex-direction:column;align-items:flex-end}.dsh-builtin-tabs{gap:6px}.dsh-builtin-tabs button{flex:1;height:auto;min-height:36px;white-space:normal;line-height:1.25}}
`
