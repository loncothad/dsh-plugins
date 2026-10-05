/** Native Plugins-page forms over the host's redacted, revision-fenced settings service. */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, Checkbox, Input, SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SchemaNode } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { configurationTheme } from './configuration-theme.ts'
import { pluginHelp } from './plugin-help-client.ts'

const en = {
  save: 'Save configuration',
  reload: 'Reload configuration and discard edits',
  reset: 'Use default',
  saved: 'Configuration saved.',
  conflict: 'Configuration changed elsewhere. Reload and try again.',
  failed: 'Configuration could not be saved.',
  unavailable: 'Enable this plugin to configure it.',
  secret: 'Leave blank to keep the saved credential.',
  loading: 'Loading configuration…',
  clearSecret: 'Clear saved credential',
  clearHelp: 'Clearing removes the saved setting; a host environment credential can still apply.',
  sections: 'Configuration sections',
  edits: 'Unsaved changes',
  clean: 'Up to date',
  discard: 'Discard edits',
  fields: 'settings',
  field: 'setting',
}
const zh: typeof en = {
  save: '保存配置',
  reload: '重新加载配置并放弃编辑',
  reset: '使用默认值',
  saved: '配置已保存。',
  conflict: '配置已在其他位置更改。请刷新后重试。',
  failed: '无法保存配置。',
  unavailable: '启用此插件以配置。',
  secret: '留空以保留已保存的凭据。',
  loading: '正在加载配置…',
  clearSecret: '清除已保存的凭据',
  clearHelp: '清除保存的设置后，主机环境中的凭据仍可能生效。',
  sections: '配置分区',
  edits: '未保存的更改',
  clean: '已同步',
  discard: '放弃编辑',
  fields: '项设置',
  field: '项设置',
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    [key: `plugins.config.${string}`]: keyof typeof en
  }
}

const humanName = (name: string) =>
  name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/Api/g, 'API')
    .replace(/^./, (c) => c.toUpperCase())
const inputStyle = { width: '100%', minWidth: 0, boxSizing: 'border-box' as const }
export interface ConfigurationSectionProps {
  getValue(field: string): string
  setValue(field: string, value: string): void
  setError(field: string, error: string | undefined, source: string): void
  disabled: boolean
}
export interface ConfigurationSection {
  fields: string[]
  standardFields?: string[]
  component: React.ComponentType<ConfigurationSectionProps>
}
export interface ConfigurationGroup {
  title: string
  description: string
  fields: string[]
}

/** Register bundle and row forms using the entry id declared by the owning bundle. */
export function registerConfiguration(
  ctx: Context,
  options: {
    packageName: string
    rowId: string
    before?: React.ComponentType
    sections?: ConfigurationSection[]
    groups?: ConfigurationGroup[]
  },
): void {
  const ns = `plugins.config.${options.rowId}` as const
  ctx.effect(() => ctx.locale.register(ns, { en, zh }), 'plugin-config: copy')
  const t = ctx.locale.bind(ns)
  const form = ctx.configForms.get<Record<string, unknown>>(options.rowId)
  const describe = ctx.configForms.describe()
  function Page() {
    const state = useSyncExternalStore(
      (listener) => form.subscribe(listener),
      () => form.getSnapshot(),
    )
    const mirror = useSyncExternalStore(
      (listener) => describe.subscribe(listener),
      () => describe.getSnapshot(),
    )
    const errorsRef = useRef<Record<string, string>>({})
    const [errors, setErrors] = useState<Record<string, string>>({})
    const [draft, setDraft] = useState<Record<string, string>>({})
    const [resets, setResets] = useState<string[]>([])
    const [message, setMessage] = useState('')
    const [busy, setBusy] = useState(false)
    const [revision, setRevision] = useState<number | undefined>(state.revision)
    useEffect(() => {
      if (!Object.keys(draft).length && !resets.length) setRevision(state.revision)
    }, [state.revision, draft, resets])
    if (state.status !== 'ready')
      return h('p', { role: 'status' }, t(state.status === 'loading' ? 'loading' : 'unavailable'))
    const view = mirror.view?.namespaces.find((row) => row.ns === options.rowId)
    if (!view) return h('p', null, t('unavailable'))
    const schema = ctx.settingsSchema.rehydrate(view.schema)
    const nodes: { path: string[]; node: SchemaNode }[] = []
    const collect = (node: SchemaNode, path: string[]) => {
      if (node.type === 'object')
        for (const [key, child] of Object.entries(node.dict ?? {})) collect(child, [...path, key])
      else nodes.push({ path, node })
    }
    collect(schema, [])
    const valueAt = (path: string[]) =>
      path.reduce<unknown>(
        (value, key) => (value && typeof value === 'object' ? Reflect.get(value, key) : undefined),
        state.value,
      )
    const customFields = new Set(
      options.sections?.flatMap((section) =>
        section.fields.filter((field) => !section.standardFields?.includes(field)),
      ) ?? [],
    )
    const changed = (key: string, raw: string) => {
      setDraft((previous) => ({ ...previous, [key]: raw }))
      setResets((previous) => previous.filter((item) => item !== key))
      setMessage('')
    }
    const save = async () => {
      if (Object.keys(errorsRef.current).length) {
        setMessage('Fix invalid configuration fields before saving.')
        return
      }
      setBusy(true)
      setMessage('')
      try {
        const ops = nodes.flatMap<SettingsPathOpView>(({ path, node }) => {
          const key = path.join('.')
          if (resets.includes(key)) return [{ op: 'unset' as const, path }]
          if (!Object.hasOwn(draft, key) || (node.meta.role === 'secret' && draft[key] === ''))
            return []
          const raw = draft[key]!
          if (
            raw === '' &&
            (node.type === 'boolean' ||
              (node.type === 'union' &&
                node.list?.every(
                  (choice) => choice.type === 'const' && typeof choice.value === 'string',
                )))
          )
            return [{ op: 'unset' as const, path }]
          const value =
            node.type === 'array' && node.inner?.type === 'string' && !customFields.has(key)
              ? raw
                  .split('\n')
                  .map((item) => item.trim())
                  .filter(Boolean)
              : node.type === 'number'
                ? Number(raw)
                : node.type === 'boolean'
                  ? raw === 'true'
                  : node.type === 'array' || node.type === 'dict'
                    ? JSON.parse(raw)
                    : raw
          if (node.type === 'number' && (raw.trim() === '' || !Number.isFinite(value)))
            throw new Error(`${humanName(key)} requires a finite number`)
          return [{ op: 'set' as const, path, value }]
        })
        const accepted = await form.mutate(ops, revision)
        setMessage(t(accepted ? 'saved' : 'conflict'))
        if (accepted) {
          setDraft({})
          setResets([])
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : t('failed'))
      } finally {
        setBusy(false)
      }
    }
    const customSections = (options.sections ?? []).map((section, index) =>
      h(section.component, {
        key: index,
        disabled: busy || !state.writable,
        getValue: (field) => {
          const type = nodes.find((row) => row.path.join('.') === field)?.node.type
          const empty = type === 'dict' || type === 'object' ? '{}' : type === 'array' ? '[]' : ''
          if (resets.includes(field)) return empty
          const current = valueAt(field.split('.'))
          return (
            draft[field] ??
            (typeof current === 'object' && current !== null
              ? JSON.stringify(current)
              : current === undefined
                ? empty
                : String(current))
          )
        },
        setError: (field, error, source) => {
          if (!section.fields.includes(field))
            throw new Error('Custom editor attempted to validate an undeclared field')
          const key = `${index}:${field}:${source}`
          if (errorsRef.current[key] === error) return
          const next = { ...errorsRef.current }
          if (error) next[key] = error
          else delete next[key]
          errorsRef.current = next
          setErrors(next)
        },
        setValue: (field, raw) => {
          if (!section.fields.includes(field))
            throw new Error('Custom editor attempted to change an undeclared field')
          changed(field, raw)
        },
      }),
    )
    const sectionGroups = groupFields(
      nodes.filter(({ path }) => !customFields.has(path.join('.'))),
      options.groups,
    )
    const dirty = Boolean(Object.keys(draft).length || resets.length)
    const discard = () => {
      setDraft({})
      setResets([])
      setRevision(state.revision)
      setMessage('')
    }
    const standardSections = groupFields(
      nodes.filter(({ path }) => !customFields.has(path.join('.'))),
      options.groups,
    ).map((group) =>
      h(
        'section',
        {
          key: group.title,
          className: 'config-section',
          id: `${options.rowId}-${group.title.replaceAll(' ', '-').toLowerCase()}`,
          tabIndex: -1,
          'aria-label': group.title,
        },
        h(
          'header',
          { className: 'config-section-header' },
          h('h3', null, group.title),
          h(
            'span',
            { className: 'config-badge' },
            `${group.fields.length} ${t(group.fields.length === 1 ? 'field' : 'fields')}`,
          ),
        ),
        h(
          'p',
          { className: 'config-section-description' },
          options.groups?.find((row) => row.title === group.title)?.description ??
            sectionDescriptions[group.title],
        ),
        ...group.fields.map(({ path, node }) => {
          const key = path.join('.')
          const secret = node.meta.role === 'secret'
          const current = valueAt(path)
          const value =
            draft[key] ??
            (secret
              ? ''
              : node.type === 'array' && node.inner?.type === 'string' && Array.isArray(current)
                ? current.join('\n')
                : typeof current === 'object'
                  ? JSON.stringify(current, null, 2)
                  : String(current ?? ''))
          const props = {
            'aria-describedby': `${options.rowId}-${key}-description`,
            id: `${options.rowId}-${key}`,
            value,
            disabled: busy || !state.writable,
            style: inputStyle,
            onChange: (
              event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
            ) => changed(key, event.target.value),
          }
          const choices =
            node.type === 'union' &&
            node.list?.every(
              (choice) => choice.type === 'const' && typeof choice.value === 'string',
            )
              ? node.list.map((choice) => String(choice.value))
              : undefined
          const arrayChoices =
            node.type === 'array' &&
            node.inner?.type === 'union' &&
            node.inner.list?.every(
              (choice) => choice.type === 'const' && typeof choice.value === 'string',
            )
              ? node.inner.list.map((choice) => String(choice.value))
              : undefined
          const selectedChoices = arrayChoices
            ? Object.hasOwn(draft, key)
              ? JSON.parse(draft[key]!)
              : (current ?? node.meta.default ?? [])
            : []
          const editor = arrayChoices
            ? h(
                'div',
                { style: { display: 'flex', gap: 16, flexWrap: 'wrap' } },
                ...arrayChoices.map((choice) =>
                  h(Checkbox, {
                    key: choice,
                    label: choice === '3d' ? '3D assets' : humanName(choice),
                    checked: Array.isArray(selectedChoices) && selectedChoices.includes(choice),
                    disabled: busy || !state.writable,
                    onChange: (checked: boolean) => {
                      const next = new Set<string>(
                        Array.isArray(selectedChoices) ? selectedChoices : [],
                      )
                      if (checked) next.add(choice)
                      else next.delete(choice)
                      changed(key, JSON.stringify([...next]))
                    },
                  }),
                ),
              )
            : choices
              ? h(
                  'select',
                  props,
                  h('option', { value: '' }, 'Default'),
                  ...choices.map((choice) => h('option', { key: choice, value: choice }, choice)),
                )
              : node.type === 'boolean'
                ? h(
                    'select',
                    props,
                    h('option', { value: '' }, 'Default'),
                    h('option', { value: 'true' }, 'Enabled'),
                    h('option', { value: 'false' }, 'Disabled'),
                  )
                : node.type === 'array' ||
                    node.type === 'dict' ||
                    /prompt|guidance|chains|links|mapping|map$/i.test(key)
                  ? h('textarea', { ...props, rows: 4, spellCheck: false })
                  : h(
                      'div',
                      {
                        style: {
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr)',
                          minWidth: 0,
                        },
                      },
                      h(Input, {
                        className: 'config-input',
                        ...props,
                        style: { width: '100%', minWidth: 0, boxSizing: 'border-box' },
                        type: secret ? 'password' : node.type === 'number' ? 'number' : 'text',
                        autoComplete: secret ? 'new-password' : 'off',
                        min: node.meta.min,
                        max: node.meta.max,
                        step: node.type === 'number' ? (node.meta.step ?? 'any') : undefined,
                      }),
                    )
          return h(
            'div',
            {
              key,
              className: `config-field config-field-row${node.type === 'dict' || (node.type === 'array' && !arrayChoices) ? ' config-field-wide' : ''}`,
            },
            h(
              'div',
              { className: 'config-field-copy' },
              h(
                'div',
                { className: 'config-field-head' },
                h('label', { htmlFor: props.id }, fieldLabel(key, options.rowId)),
                h(
                  Button,
                  {
                    type: 'button',
                    disabled: busy || !state.writable,
                    onClick: () => {
                      setResets((previous) => [...new Set([...previous, key])])
                      setDraft((previous) => {
                        const next = { ...previous }
                        delete next[key]
                        return next
                      })
                    },
                  },
                  t(secret ? 'clearSecret' : 'reset'),
                ),
              ),
              node.meta.description
                ? h(
                    'p',
                    { id: `${props.id}-description` },
                    typeof node.meta.description === 'string'
                      ? node.meta.description
                      : ctx.locale.resolveText({
                          en: node.meta.description.en ?? humanName(key),
                          ...node.meta.description,
                        }),
                  )
                : null,
              secret ? h('small', null, t('secret')) : null,
              resets.includes(key)
                ? h(
                    'p',
                    { role: 'status' },
                    secret ? t('clearHelp') : 'The default will apply after saving.',
                  )
                : null,
            ),
            h('div', { className: 'config-field-control' }, editor),
          )
        }),
      ),
    )
    return h(
      'form',
      {
        className: 'dsh-plugin-settings',
        onSubmit: (event: React.FormEvent) => {
          event.preventDefault()
          void save()
        },
      },
      h('style', null, configurationTheme),
      h(
        'div',
        { className: 'config-overview' },
        h(
          'nav',
          { className: 'config-navigation', 'aria-label': t('sections') },
          ...sectionGroups.map((group) =>
            h(
              Button,
              {
                key: group.title,
                type: 'button',
                variant: 'ghost',
                size: 'sm',
                onClick: () => {
                  const target = document.getElementById(
                    `${options.rowId}-${group.title.replaceAll(' ', '-').toLowerCase()}`,
                  )
                  target?.scrollIntoView({ block: 'start' })
                  target?.focus({ preventScroll: true })
                },
              },
              group.title,
            ),
          ),
        ),
        h(
          'div',
          { className: 'config-edit-state' },
          h(
            'span',
            { className: `config-badge${dirty ? ' config-badge-pending' : ''}`, role: 'status' },
            t(dirty ? 'edits' : 'clean'),
          ),
          dirty
            ? h(
                Button,
                {
                  type: 'button',
                  size: 'sm',
                  variant: 'outline',
                  disabled: busy,
                  onClick: discard,
                },
                t('discard'),
              )
            : null,
        ),
      ),
      h(
        SettingsForm,
        {
          // biome-ignore lint/correctness/noChildrenProp: The native SettingsForm type requires this prop; actual children are passed as createElement arguments.
          children: undefined,
          labels: {
            unavailable: t('unavailable'),
            readOnly: 'This deployment stores configuration as read-only.',
            saveFailed: t('failed'),
            save: t('save'),
            saving: 'Saving…',
          },
          state: {
            available: true,
            writable: state.writable,
            dirty: Boolean(Object.keys(draft).length || resets.length),
            invalid: Boolean(Object.keys(errors).length),
            saving: busy,
            failed: false,
          },
          onSave: () => {
            void save()
          },
          onDiscard: () => {},
        },
        pluginHelp[options.rowId]
          ? h('p', { className: 'config-help' }, pluginHelp[options.rowId])
          : null,
        options.before ? h('div', { className: 'config-section' }, h(options.before)) : null,
        ...standardSections.filter((section) => section.key === 'Connection and accounts'),
        ...customSections.map((section, index) =>
          h('div', { key: `custom-${index}`, className: 'config-section' }, section),
        ),
        ...standardSections.filter((section) => section.key !== 'Connection and accounts'),
      ),
      Object.keys(errors).length
        ? h(
            'p',
            { role: 'alert', className: 'config-status' },
            [...new Set(Object.values(errors))].join(' '),
          )
        : null,
      message ? h('p', { role: 'status', className: 'config-status' }, message) : null,
      message === t('conflict')
        ? h(
            Button,
            {
              type: 'button',
              disabled: busy,
              onClick: () => {
                setDraft({})
                setResets([])
                setRevision(state.revision)
                setMessage('')
              },
            },
            t('reload'),
          )
        : null,
    )
  }
  for (const registration of [
    { name: 'plugins.bundle.config' as const, key: options.packageName },
    { name: 'plugins.row.config' as const, key: `${options.packageName}#${options.rowId}` },
  ])
    ctx.slots.inject(registration.name, () => ctx.slots.register(registration, Page))
}

export { accountStatus, authenticationControls } from './auth-client.ts'
export { configurationTheme } from './configuration-theme.ts'
export { type ModelRouteProps, modelRoutePicker } from './model-route-client.ts'

const fieldLabels: Record<string, string> = {
  credentialSource: 'Credential source',
  secretReference: 'Scoped secret reference',
  brokerOrigins: 'Approved credential origins : one per line',
  environment: 'Deployment environment',
  rootDirectory: 'Independent environment homes',
  environmentOverrides: 'Environment configuration layers',
  userOverrides: 'User/profile configuration layer',
  defaults: 'Default configuration layer',
  allowedTools: 'Admitted tools',
  leaseMs: 'Credential or worker lease lifetime (milliseconds)',
  operationTimeoutMs: 'Total operation deadline (milliseconds)',
  maxConcurrentJobs: 'Concurrent operation limit',
  maxModelCalls: 'Reserved model calls per run',
  maxToolCalls: 'Reserved tool calls per run',
  maxOutputCharacters: 'Model output character limit',
  requireWorktree: 'Require an isolated work session',
  branchPrefix: 'Dedicated branch prefix',
  maxCheckpoints: 'Retained checkpoint quota',
  includeTextPreviews: 'Show bounded text previews',
  goalContract: 'Goal completion evidence contract',
  requireDifferentModel: 'Use a separate generation and verifier model',
  modelVerification: 'Enable independent model verification',
  contracts: 'Declared evidence contracts',
  verifiers: 'Trusted verifier recipes',
  sourceOrigins: 'Admitted evidence origins and publisher groups',
  references: 'Scoped credential references',
  defaultEffect: 'Default action decision',
  honorFullAccess: 'Honor Full Access',
  rules: 'Action rules',
  automatic: 'Automatic summary trigger',
  everyTurns: 'Completed turns between summaries',
  generation: 'Summary generation method',
  retentionMode: 'Readable context retention strategy',
  apiKey: 'API key',
  endpoint: 'API endpoint',
  catalogProtocolVersion: 'Codex catalog protocol version',
  apiBaseUrl: 'API base URL',
  codes: 'Reset error codes',
  retryableCodes: 'Errors to retry',
  fallbackCodes: 'Errors that allow fallback',
  chains: 'Fallback routes : one route per line',
  roots: 'Package search roots : one path per line',
  presets: 'Agent presets : one entry ID per line',
  pins: 'Exact instructions to preserve : one per line',
  pinnedProvider: 'Default upstream provider',
  modelProviders: 'Upstream provider for each model',
  mediaModelOptions: 'Advanced model parameter defaults',
  mediaOutputs: 'Enabled media tasks',
  extractionEnabled: 'Use a model to extract historical memory',
  extractionBudgetUsd: 'Extraction spending limit per session (USD)',
  dataDir: 'Evidence storage directory',
  imageOutDir: 'Image output directory',
  accountFallback: 'Use another signed-in account when quota is exhausted',
  accountFallbackExclude: 'Accounts excluded from automatic fallback',
  daybreakProgram: 'Daybreak access program',
  maxInputBytes: 'Maximum total input bytes',
  maxOutputBytes: 'Maximum total output bytes',
  maxFiles: 'Maximum generated files',
  timeoutMs: 'Operation deadline (milliseconds)',
  pollMs: 'Queue polling interval (milliseconds)',
  mediaTools: 'Enable media tools',
  mediaSkills: 'Enable built-in media skills',
  mediaCommands: 'Enable media commands',
  mediaEnabled: 'Enable media capabilities',
  mediaTimeoutMs: 'Media operation deadline (milliseconds)',
  mediaOutDir: 'Generated media directory',
  imageBudgetTokens: 'Conservative token reservation per image',
  preferredProvider: 'Default upstream provider',
  dataCollection: 'Provider data collection policy',
  zeroDataRetention: 'Require zero data retention',
  maxPrice: 'Maximum provider prices (USD)',
  sort: 'Provider preference order',
  requireParameters: 'Require support for every request parameter',
  allowFallbacks: 'Allow another upstream provider',
  extractionProvider: 'Historical extraction provider',
  extractionModel: 'Historical extraction model',
  extractionTimeoutMs: 'Extraction deadline (milliseconds)',
  extractionFallbackContextWindow: 'Explicit extraction context capacity',
  archiveIntervalMs: 'Maintenance interval (milliseconds)',
  archiveEnabled: 'Compress cold evidence objects',
  archiveCodec: 'Cold object compression format',
  retentionDays: 'Inactive session retention (days)',
  installOnEnable: 'Replace standard and PTC compactors automatically',
  fallbackContextWindow: 'Explicit context capacity when undisclosed',
  outputReserve: 'Tokens reserved for the model response',
  safetyTokens: 'Token estimation headroom',
  toolResultReserve: 'Tokens reserved for the next tool result',
  'bash.cwd': 'Default working directory',
  'bash.timeoutMs': 'Default shell deadline (milliseconds)',
  'bash.maxTimeoutMs': 'Maximum shell deadline (milliseconds)',
  'bash.maxOutputBytes': 'Maximum inline shell output bytes',
  'bash.maxSpillBytes': 'Maximum spilled shell output bytes',
  'bash.graceMs': 'Process termination grace (milliseconds)',
  maxOpenWorkspaces: 'Maximum open workspace archives',
  maxActiveSessions: 'Maximum active session ledgers',
  kagiKey: 'Kagi API key',
  exaKey: 'Exa API key',
  openrouterKey: 'OpenRouter API key',
  mode: 'Mode',
  wrapper: 'Dev shell command template',
}
function fieldLabel(key: string, owner?: string): string {
  if (owner === 'heads-up') {
    const labels: Record<string, string> = {
      automatic: 'Review work automatically',
      reviewMain: 'Review the main agent',
      reviewSubagents: 'Review subagent work',
      everyEvents: 'Settled events between reviews',
      debounceMs: 'Review delay (milliseconds)',
      includeToolOutputs: 'Review tool results',
      includeLatestUserRequest: 'Include the latest user request',
      workspaceDiffs: 'Include a local Git snapshot',
      modelEnabled: 'Enable independent model review',
      reviewerEffort: 'Reviewer reasoning effort',
      requireDifferentModel: 'Require a different reviewer model',
      reviewerGuidance: 'Additional review instructions',
      categories: 'Concerns to report',
      minimumSeverity: 'Minimum notice severity',
      maxNotices: 'Retained notices per chat',
      maxBudgetUsd: 'Reserved review budget per chat (USD)',
      inputUsdPerMillion: 'Input price per million tokens (USD)',
      outputUsdPerMillion: 'Output price per million tokens (USD)',
      allowUnknownBilling: 'Allow unknown prices',
      maxModelCallsPerChat: 'Maximum model reviews per chat',
      maxInputCharacters: 'Evidence packet character limit',
      maxEventCharacters: 'Excerpt character limit per event',
      maxWindowsPerReview: 'Evidence windows per review',
      maxOutputTokens: 'Reviewer output token limit',
      commandEnabled: 'Enable review and notice commands',
      skillEnabled: 'Explain Heads Up to the main model',
      stateDirectory: 'Private notice storage directory',
    }
    if (labels[key]) return labels[key]!
  }
  if (owner === 'path-globs') {
    const labels: Record<string, string> = {
      automatic: 'Expand globs in user messages',
      commandEnabled: 'Enable glob previews',
      rootMode: 'Project root',
      projectRoot: 'Configured project root',
      honorIgnoreFiles: 'Honor project ignore files',
      respectGitignore: 'Honor .gitignore',
      respectIgnore: 'Honor .ignore',
      additionalIgnoreFiles: 'Additional ignore files : one filename per line',
      nestedIgnoreFiles: 'Read ignore files in child directories',
      additionalExcludes: 'Additional exclusions : one rule per line',
    }
    if (labels[key]) return labels[key]!
  }
  if (key === 'mode' && owner === 'shell-devenv') return 'Dev shell activation'
  if (key === 'mode' && owner === 'policy-engine') return 'Policy enforcement mode'
  return fieldLabels[key] ?? humanName(key).replace(/Openai/g, 'OpenAI')
}
function groupFields<T extends { path: string[] }>(
  fields: T[],
  declared: ConfigurationGroup[] = [],
): { title: string; fields: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const field of fields) {
    const key = field.path.join('.')
    const title =
      declared.find((group) => group.fields.includes(key))?.title ??
      (/key|endpoint|account|login|host|baseUrl/i.test(key)
        ? 'Connection and accounts'
        : /media|image|video|audio|mesh/i.test(key)
          ? 'Media capabilities and defaults'
          : /regular|sisyphus|checkpoint|modelAdvance|modelTools|catalog|model|provider|speed|reasoning|daybreak|retry|fallback|chains/i.test(
                key,
              )
            ? 'Models and routing'
            : /prompt|guidance|mapping|section|pins/i.test(key)
              ? 'Instructions and prompts'
              : /timeout|poll|bytes|files|interval|budget|reserve|safety|archive|retention|dataDir|maxOpenWorkspaces|maxActiveSessions/i.test(
                    key,
                  )
                ? 'Resource limits and storage'
                : 'Behavior')
    const values = groups.get(title) ?? []
    values.push(field)
    groups.set(title, values)
  }
  const order = [
    ...declared.map((group) => group.title),
    'Connection and accounts',
    'Models and routing',
    'Media capabilities and defaults',
    'Instructions and prompts',
    'Behavior',
    'Resource limits and storage',
  ]
  return [...groups]
    .map(([title, fields]) => ({ title, fields }))
    .sort((a, b) => order.indexOf(a.title) - order.indexOf(b.title))
}

export { configurationModel } from './configuration-model.ts'
export { privateStateClient, privateStateObservation } from './private-state-client.ts'
export { connectRemote, remoteValue } from './remote-client.ts'
export { configurationStatus } from './status-client.ts'

const sectionDescriptions: Record<string, string> = {
  'Connection and accounts': 'Connect your provider and manage the account used for operations.',
  'Models and routing': 'Choose models and control how requests reach them.',
  'Media capabilities and defaults': 'Choose available media tasks and their default parameters.',
  'Instructions and prompts': 'Set the instructions and constraints applied to this capability.',
  'Resource limits and storage': 'Bound execution time, resource use, and retained data.',
  Behavior: 'Control when this capability runs and how it responds.',
}

export {
  type ConversationPanelProps,
  openConversationPanel,
  registerConversationPanel,
} from './conversation-panels-client.ts'
