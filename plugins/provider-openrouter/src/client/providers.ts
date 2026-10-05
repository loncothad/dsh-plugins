import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigurationSectionProps } from '@loncothad/dsh-plugin-runtime/client'
import { registerConversationPanel } from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { type Endpoint, fetchEndpoints } from '../endpoints.ts'
import { publicJson } from '../public-json.ts'

/** Both the Plugins page and composer edit the same revision-fenced, per-model preference. */
export function providerControls(ctx: Context) {
  const form = ctx.configForms.get<Record<string, unknown>>('provider-openrouter')
  function Choices({
    model,
    selected,
    disabled,
    onSelect,
  }: {
    model: string
    selected: string
    disabled: boolean
    onSelect(tag: string): void
  }) {
    const groupId = useId()
    const [rows, setRows] = useState<Endpoint[]>([])
    const [status, setStatus] = useState('')
    const [refresh, setRefresh] = useState(0)
    // biome-ignore lint/correctness/useExhaustiveDependencies: The refresh counter explicitly retries the same model catalog request.
    useEffect(() => {
      const controller = new AbortController()
      setRows([])
      setStatus('Loading upstream providers…')
      void fetchEndpoints(model, controller.signal).then(
        (rows) => {
          if (!controller.signal.aborted) {
            setRows(rows)
            setStatus(rows.length ? '' : 'No upstream endpoints are listed for this model.')
          }
        },
        (error) => {
          if (!controller.signal.aborted)
            setStatus(error instanceof Error ? error.message : 'Could not load upstream providers.')
        },
      )
      return () => controller.abort()
    }, [model, refresh])
    const metric = (value: number | undefined, unit: string) =>
      value === undefined
        ? 'Unknown'
        : `${value.toLocaleString(undefined, { maximumSignificantDigits: 6 })}${unit}`
    return h(
      'div',
      { style: { overflowX: 'auto', maxWidth: '100%' } },
      h('p', null, model, '. Provider choice applies to this model in all sessions.'),
      h(
        'details',
        null,
        h('summary', null, 'All endpoint metrics and policy evidence'),
        h(
          'div',
          {
            role: 'region',
            'aria-label': 'Endpoint metrics',
            tabIndex: 0,
            style: { overflowX: 'auto', maxWidth: '100%', minWidth: 0 },
          },
          h(
            'table',
            { style: { marginTop: 12, width: '100%', fontSize: 13 } },
            h(
              'caption',
              null,
              'Endpoint observations from OpenRouter. Prices show their units; undisclosed units stay unknown.',
            ),
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                ...[
                  'Provider',
                  'Input / output',
                  'Latency p50 (30m)',
                  'Throughput p50 (30m)',
                  'Uptime (1d)',
                  'Data retention',
                ].map((label) =>
                  h(
                    'th',
                    { key: label, scope: 'col', style: { textAlign: 'left', padding: 6 } },
                    label,
                  ),
                ),
              ),
            ),
            h(
              'tbody',
              null,
              ...rows.map((row) =>
                h(
                  'tr',
                  { key: row.tag },
                  ...[
                    `${row.provider} · ${row.name} · ${row.tag}`,
                    row.prices.length
                      ? row.prices
                          .map((price) => `${price.field}: ${metric(price.rate, '')} ${price.unit}`)
                          .join(' · ')
                      : 'Price unknown',
                    metric(row.latency, 's'),
                    metric(row.throughput, row.tokenMetrics ? ' tok/s' : ' (unit unknown)'),
                    metric(row.uptime, '%'),
                  ].map((value, i) => h('td', { key: i, style: { padding: 6 } }, value)),
                  h(
                    'td',
                    { style: { padding: 6 } },
                    row.zeroRetention ? 'ZDR eligible' : 'Unknown',
                    row.privacyUrl
                      ? h(
                          'a',
                          {
                            href: row.privacyUrl,
                            target: '_blank',
                            rel: 'noreferrer',
                            style: { marginLeft: 6 },
                          },
                          'Privacy policy',
                        )
                      : null,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
      h(
        'fieldset',
        { className: 'dsh-upstream-comparison', 'aria-label': 'Upstream provider', disabled },
        h('legend', { className: 'dsh-upstream-legend' }, 'Choose provider'),
        h(
          'label',
          { className: 'dsh-upstream-option', 'data-selected': selected === '' || undefined },
          h('input', {
            type: 'radio',
            name: groupId,
            value: '',
            checked: selected === '',
            onChange: () => onSelect(''),
          }),
          h(
            'div',
            null,
            h('strong', null, 'Use global routing'),
            h('small', null, 'Apply your global routing and privacy preferences.'),
          ),
        ),
        selected && !rows.some((row) => row.tag === selected)
          ? h(
              'label',
              { className: 'dsh-upstream-option', 'data-selected': true },
              h('input', {
                type: 'radio',
                name: groupId,
                value: selected,
                checked: true,
                readOnly: true,
              }),
              h(
                'div',
                null,
                h('strong', null, selected),
                h(
                  'small',
                  null,
                  'Selected endpoint is not in the current catalog. Refresh to check availability.',
                ),
              ),
            )
          : null,
        ...rows.map((row) =>
          h(
            'label',
            {
              key: row.tag,
              className: 'dsh-upstream-option',
              'data-selected': selected === row.tag || undefined,
            },
            h('input', {
              type: 'radio',
              name: groupId,
              value: row.tag,
              checked: selected === row.tag,
              onChange: () => onSelect(row.tag),
            }),
            h(
              'div',
              null,
              h(
                'div',
                { className: 'dsh-upstream-row-head' },
                h('strong', null, row.provider),
                h('small', null, row.zeroRetention ? 'ZDR eligible' : 'Retention unknown'),
              ),
              h('small', null, row.tag),
              h(
                'p',
                null,
                row.prices
                  .filter((price) => ['prompt', 'completion'].includes(price.field))
                  .map(
                    (price) =>
                      `${price.field === 'prompt' ? 'Input' : 'Output'} ${metric(price.rate, '')} ${price.unit.replace('USD / million tokens', 'USD/M tokens')}`,
                  )
                  .join(' · ') || 'Price unknown',
              ),
              h(
                'small',
                null,
                `Latency ${metric(row.latency, 's')} · Throughput ${metric(row.throughput, row.tokenMetrics ? ' tok/s' : ' (unit unknown)')} · Uptime ${metric(row.uptime, '%')}`,
              ),
            ),
          ),
        ),
      ),
      h(
        'style',
        null,
        '.dsh-upstream-comparison{max-height:390px;overflow:auto;margin:12px 0;border:0;padding:0;min-width:0;}.dsh-upstream-legend{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:8px;}.dsh-upstream-option{display:grid;grid-template-columns:20px minmax(0,1fr);gap:12px;padding:12px;margin:0 0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);cursor:pointer;background:var(--dsw-alias-bg-base);}.dsh-upstream-option[data-selected]{border-color:var(--dsw-alias-label-link,#406cff);background:var(--dsw-alias-bg-layer-2);}.dsh-upstream-option:focus-within{outline:2px solid var(--dsw-alias-label-link,#406cff);outline-offset:2px;}.dsh-upstream-option input{margin:3px 0 0;accent-color:var(--dsw-alias-label-link,#406cff);}.dsh-upstream-option>div{min-width:0;overflow-wrap:anywhere;}.dsh-upstream-option small{display:block;color:var(--dsw-alias-label-secondary);}.dsh-upstream-row-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;}.dsh-upstream-option p{margin:5px 0;}.dsh-plugin-settings details>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;}',
      ),
      h(
        Button,
        {
          variant: 'outline',
          size: 'sm',
          type: 'button',
          onClick: () => setRefresh((value) => value + 1),
        },
        'Refresh metrics',
      ),
      rows.length
        ? h(
            'p',
            null,
            `Fetched ${new Date(rows[0]!.observedAt).toLocaleString()}. Latency and throughput cover the last 30 minutes; uptime covers one day. ZDR eligibility does not establish other retention policies.`,
          )
        : null,
      status ? h('p', { role: 'status' }, status) : null,
    )
  }
  function Page({ getValue, setValue, disabled }: ConfigurationSectionProps) {
    const raw = getValue('modelProviders')
    const choices: Record<string, string> = raw ? JSON.parse(raw) : {}
    const [model, setModel] = useState('')
    const [query, setQuery] = useState('')
    const [models, setModels] = useState<{ id: string; name: string }[]>([])
    const [error, setError] = useState('')
    useEffect(() => {
      const controller = new AbortController()
      const urls = [
        'https://openrouter.ai/api/v1/models',
        'https://openrouter.ai/api/v1/models?output_modalities=speech',
        'https://openrouter.ai/api/v1/models?output_modalities=transcription',
        'https://openrouter.ai/api/v1/videos/models',
      ]
      void Promise.allSettled(
        urls.map(async (url) => {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
          const response = await fetch(url, { signal, credentials: 'omit' })
          if (!response.ok) throw new Error(`Catalog request failed (HTTP ${response.status})`)
          const payload = await publicJson(response, signal)
          const data =
            payload && typeof payload === 'object' && 'data' in payload ? payload.data : undefined
          if (!Array.isArray(data)) throw new Error('Model catalog is malformed')
          return data.flatMap((item) =>
            item && typeof item === 'object' && typeof item.id === 'string'
              ? [{ id: item.id, name: typeof item.name === 'string' ? item.name : item.id }]
              : [],
          )
        }),
      ).then((results) => {
        if (controller.signal.aborted) return
        const unique = new Map<string, { id: string; name: string }>()
        for (const result of results)
          if (result.status === 'fulfilled')
            for (const model of result.value) unique.set(model.id, model)
        setModels([...unique.values()])
        if (results.some((result) => result.status === 'rejected'))
          setError('Some model catalogs are unavailable. Existing preferences are preserved.')
      })
      return () => controller.abort()
    }, [])
    return h(
      'section',
      { style: { minWidth: 0 } },
      h('h3', null, 'Upstream providers by model'),
      h(Input, {
        className: 'config-input',
        type: 'search',
        'aria-label': 'Search OpenRouter models',
        value: query,
        maxLength: 256,
        disabled,
        placeholder: 'Search model name or ID',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
        style: { width: '100%', marginBottom: 8 },
      }),
      h(
        'select',
        {
          'aria-label': 'OpenRouter model',
          value: model,
          disabled,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setModel(event.target.value),
          style: {
            boxSizing: 'border-box',
            width: '100%',
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l4)',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)',
          },
        },
        h('option', { value: '' }, 'Choose a model'),
        ...Object.keys(choices)
          .filter((id) => !models.some((row) => row.id === id))
          .map((id) =>
            h('option', { key: id, value: id }, `${id} (saved preference; not in current catalog)`),
          ),
        ...models
          .filter(
            (row) =>
              row.id === model ||
              `${row.id} ${row.name}`.toLowerCase().includes(query.trim().toLowerCase()),
          )
          .slice(0, 200)
          .map((row) => h('option', { key: row.id, value: row.id }, row.name)),
      ),
      error ? h('p', { role: 'status' }, error) : null,
      h('p', null, 'Search narrows this model list; at most 200 matches are shown.'),
      h(
        'p',
        null,
        'Provider preferences and other configuration changes are applied together when you save below.',
      ),
      model
        ? h(Choices, {
            key: model,
            model,
            selected: choices[model] ?? '',
            disabled,
            onSelect: (tag) => {
              const next = { ...choices }
              if (tag) next[model] = tag
              else delete next[model]
              setValue('modelProviders', JSON.stringify(next))
            },
          })
        : null,
    )
  }
  function SavedChoices({ model }: { model: string }) {
    const config = useSyncExternalStore(
      (listener) => form.subscribe(listener),
      () => form.getSnapshot(),
    )
    const [busy, setBusy] = useState(false)
    const [status, setStatus] = useState('')
    const choices = config.value?.modelProviders as Record<string, string> | undefined
    const set = async (tag: string) => {
      setBusy(true)
      try {
        const accepted = await form.mutate(
          [
            tag
              ? { op: 'set', path: ['modelProviders', model], value: tag }
              : { op: 'unset', path: ['modelProviders', model] },
          ],
          config.revision,
        )
        setStatus(
          accepted
            ? 'Provider preference saved.'
            : 'Configuration changed elsewhere. Reopen this selector before saving again.',
        )
      } catch {
        setStatus('Could not save provider preference.')
      } finally {
        setBusy(false)
      }
    }
    return h(
      'div',
      null,
      h(Choices, {
        model,
        selected: choices?.[model] ?? '',
        disabled: busy || config.status !== 'ready' || !config.writable,
        onSelect: (tag) => {
          void set(tag)
        },
      }),
      status ? h('p', { role: 'status' }, status) : null,
    )
  }
  function Composer({
    sessionId,
    scope,
  }: PropsRuntime<'conversation.input.left'> & { scope: Context }) {
    const directory = scope.modelDirectories.directoryFor(sessionId)
    const state = useSyncExternalStore(
      (listener) => directory.store.subscribe(listener),
      () => directory.store.getSnapshot(),
    )
    if (state.current?.provider !== 'openrouter')
      return h(
        'p',
        null,
        'Choose an OpenRouter model in the composer to inspect its upstream providers.',
      )
    return h(
      'div',
      { className: 'dsh-plugin-settings dsh-plugin-panel' },
      h(SavedChoices, { key: state.current.model, model: state.current.model }),
    )
  }
  ctx.inject(['modelDirectories', 'sessions', 'remote', 'remote.session'], (scope) => {
    function Available(
      props: PropsRuntime<'conversation.input.left'> & { onChange(visible: boolean): void },
    ) {
      const directory = scope.modelDirectories.directoryFor(props.sessionId)
      const state = useSyncExternalStore(
        (listener) => directory.store.subscribe(listener),
        () => directory.store.getSnapshot(),
      )
      const report = useRef(props.onChange)
      report.current = props.onChange
      const provider = state.current?.provider,
        model = state.current?.model
      useEffect(() => {
        const controller = new AbortController()
        report.current(false)
        if (provider === 'openrouter' && model)
          void fetchEndpoints(model, controller.signal).then(
            (rows) => {
              if (!controller.signal.aborted)
                report.current(new Set(rows.map((row) => row.tag)).size > 1)
            },
            () => {
              if (!controller.signal.aborted) report.current(false)
            },
          )
        return () => controller.abort()
      }, [provider, model])
      return null
    }

    registerConversationPanel(scope, {
      id: 'openrouter-upstream',
      label: 'Model providers',
      order: 5,
      visibility: Available,
      component: (props) => h(Composer, { ...props, scope }),
    })
  })
  return Page
}
