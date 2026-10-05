import type { Context } from '@deepseek-ai/cordis'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement as h, useEffect, useState } from 'react'

export interface ModelRouteProps {
  value: string
  onChange(value: string): void
  disabled: boolean
  label: string
  allowAny?: boolean
}
/** Provider-qualified routes shared by links, fallback chains and instruction mappings. */
export function modelRoutePicker(ctx: Context): React.ComponentType<ModelRouteProps> {
  let catalog: (() => ReturnType<typeof ctx.remote.session.modelCatalog>) | undefined
  ctx.inject(['remote.session'], (scope) => {
    const read = () => scope.remote.session.modelCatalog()
    catalog = read
    scope.effect(
      () => () => {
        if (catalog === read) catalog = undefined
      },
      'route picker: release catalog',
    )
  })
  return function Route({ value, onChange, disabled, label, allowAny }: ModelRouteProps) {
    const [groups, setGroups] = useState<readonly ModelProviderGroup[]>([]),
      [error, setError] = useState(''),
      [revision, setRevision] = useState(0)
    // biome-ignore lint/correctness/useExhaustiveDependencies: Revision is an explicit catalog refresh trigger.
    useEffect(() => {
      let live = true
      void Promise.resolve()
        .then(() => {
          if (!catalog) throw new Error('Enable a model provider to load routes')
          return catalog()
        })
        .then((result) => {
          if (!result.ok) throw new Error('Model catalog unavailable')
          if (live) {
            setGroups(result.value.groups)
            setError(
              result.value.failures.length
                ? 'Some provider catalogs are unavailable. Saved routes remain editable.'
                : '',
            )
          }
        })
        .catch(() => {
          if (live) setError('Could not load models. Configure a provider or refresh.')
        })
      return () => {
        live = false
      }
    }, [revision])
    const slash = value.indexOf('/'),
      provider = slash < 0 ? '' : value.slice(0, slash),
      model = slash < 0 ? '' : value.slice(slash + 1),
      models = groups.find((group) => group.id === provider)?.models ?? []
    return h(
      'fieldset',
      { disabled, style: { border: 0, padding: 0, margin: '8px 0', minWidth: 0 } },
      h('legend', null, label),
      h(
        'div',
        { className: 'config-route-picker' },
        h(
          'label',
          null,
          'Provider',
          h(
            'select',
            {
              'aria-label': `${label} provider`,
              value: provider,
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
                onChange(`${event.target.value}/`),
            },
            h('option', { value: '' }, 'Choose provider'),
            provider && !groups.some((group) => group.id === provider)
              ? h('option', { value: provider }, provider)
              : null,
            ...groups.map((group) => h('option', { key: group.id, value: group.id }, group.name)),
          ),
        ),
        h(
          'label',
          null,
          'Model',
          h(
            'select',
            {
              'aria-label': `${label} model`,
              value: model,
              disabled: disabled || !provider,
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
                onChange(`${provider}/${event.target.value}`),
            },
            h('option', { value: '' }, 'Choose model'),
            allowAny ? h('option', { value: '*' }, 'Any model in this provider') : null,
            model && model !== '*' && !models.some((row) => row.id === model)
              ? h('option', { value: model }, `${model} (not in current catalog)`)
              : null,
            ...models.map((row) => h('option', { key: row.id, value: row.id }, row.name ?? row.id)),
          ),
        ),
      ),
      h(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          size: 'sm',
          disabled,
          onClick: () => setRevision((value) => value + 1),
        },
        'Refresh models',
      ),
      error ? h('p', { role: 'status' }, error) : null,
    )
  }
}
