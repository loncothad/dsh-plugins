import type { Context } from '@deepseek-ai/cordis'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  type ConfigurationSectionProps,
  connectRemote,
  remoteValue,
} from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h, useEffect, useState } from 'react'
import { type SearchCatalog, searchModelsContribution } from '../models-wire.ts'
export function searchModels(ctx: Context, provider: 'api' | 'codex', field: string) {
  const mount = connectRemote(ctx, 'webSearchModels', searchModelsContribution)
  return function Models(props: ConfigurationSectionProps) {
    const [catalog, setCatalog] = useState<SearchCatalog>(),
      [error, setError] = useState(''),
      [revision, setRevision] = useState(0)
    // biome-ignore lint/correctness/useExhaustiveDependencies: Manual refresh reloads saved host credentials and account choices.
    useEffect(() => {
      let live = true
      void mount()
        .then((remote) => remote.list(provider))
        .then((result) => {
          if (live) {
            setCatalog(remoteValue(result))
            setError('')
          }
        })
        .catch(() => {
          if (live)
            setError('Model catalog unavailable. Save credentials or sign in, then refresh.')
        })
      return () => {
        live = false
      }
    }, [revision])
    const selected = props.getValue(field)
    return h(
      'div',
      null,
      h('h3', null, provider === 'api' ? 'OpenAI API search model' : 'ChatGPT Codex search model'),
      h(
        'label',
        null,
        'Search model',
        h(
          'select',
          {
            className: 'config-select',
            'aria-label': provider === 'api' ? 'OpenAI API search model' : 'Codex search model',
            value: selected,
            disabled: props.disabled || !catalog?.available,
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
              props.setValue(field, e.target.value),
          },
          h('option', { value: '' }, 'Choose a model'),
          selected && !catalog?.models.some((m) => m.id === selected)
            ? h('option', { value: selected }, `${selected} (saved)`)
            : null,
          ...(catalog?.models ?? []).map((m) => h('option', { key: m.id, value: m.id }, m.name)),
        ),
      ),
      h(
        'p',
        null,
        catalog?.available
          ? 'Select a model that supports Responses web search. The catalog does not advertise search support per model.'
          : (catalog?.reason ?? 'Checking provider access…'),
      ),
      h(
        Button,
        {
          size: 'sm',
          variant: 'ghost',
          disabled: props.disabled,
          onClick: () => setRevision((r) => r + 1),
        },
        'Refresh search models',
      ),
      error ? h('p', { role: 'status' }, error) : null,
    )
  }
}
