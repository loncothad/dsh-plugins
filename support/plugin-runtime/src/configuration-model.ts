import type { Context } from '@deepseek-ai/cordis'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement as h, useEffect, useState } from 'react'
import type { ConfigurationSectionProps } from './client.ts'

export function configurationModel(
  ctx: Context,
  options: { providerField: string; modelField: string; title: string; description: string },
): React.ComponentType<ConfigurationSectionProps> {
  let catalog: (() => ReturnType<typeof ctx.remote.session.modelCatalog>) | undefined
  ctx.inject(['remote.session'], (scope) => {
    const read = () => scope.remote.session.modelCatalog()
    catalog = read
    scope.effect(
      () => () => {
        if (catalog === read) catalog = undefined
      },
      'configuration catalog: release remote generation',
    )
  })
  function Model({ getValue, setValue, disabled }: ConfigurationSectionProps) {
    const [groups, setGroups] = useState<readonly ModelProviderGroup[]>([])
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)
    const [version, setVersion] = useState(0)
    // biome-ignore lint/correctness/useExhaustiveDependencies: Version is the operator-controlled catalog refresh trigger.
    useEffect(() => {
      let live = true
      setLoading(true)
      void Promise.resolve()
        .then(() => {
          if (!catalog) throw new Error('The native model catalog is not connected.')
          return catalog()
        })
        .then((result) => {
          if (!live) return
          if (!result.ok) throw new Error('The model catalog could not be loaded.')
          setGroups(result.value.groups)
          setError(
            result.value.failures.length
              ? 'Some providers could not load their catalogs. Their saved selections are retained.'
              : '',
          )
        })
        .catch(() => {
          if (live)
            setError(
              'Could not load the native model catalog. Configure or enable a provider and refresh.',
            )
        })
        .finally(() => {
          if (live) setLoading(false)
        })
      return () => {
        live = false
      }
    }, [version])
    const provider = getValue(options.providerField),
      model = getValue(options.modelField)
    const models = groups.find((group) => group.id === provider)?.models ?? []
    return h(
      'section',
      { 'aria-label': options.title },
      h('h3', null, options.title),
      h('p', null, options.description),
      h(
        'label',
        null,
        'Provider',
        h(
          'select',
          {
            value: provider,
            disabled,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
              setValue(options.providerField, event.target.value)
              setValue(options.modelField, '')
            },
            style: { display: 'block', width: '100%', margin: '8px 0 14px' },
          },
          h('option', { value: '' }, 'Choose a provider'),
          provider && !groups.some((group) => group.id === provider)
            ? h('option', { value: provider }, `${provider} (currently unavailable)`)
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
            value: model,
            disabled: disabled || !provider,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
              setValue(options.modelField, event.target.value),
            style: { display: 'block', width: '100%', margin: '8px 0 14px' },
          },
          h('option', { value: '' }, 'Choose a model'),
          model && !models.some((row) => row.id === model)
            ? h('option', { value: model }, `${model} (currently unavailable)`)
            : null,
          ...models.map((row) => h('option', { key: row.id, value: row.id }, row.name)),
        ),
      ),
      h(
        Button,
        {
          variant: 'outline',
          size: 'sm',
          type: 'button',
          disabled: loading,
          onClick: () => setVersion((value) => value + 1),
        },
        loading ? 'Loading catalog…' : 'Refresh model catalog',
      ),
      error ? h('p', { role: 'status' }, error) : null,
    )
  }
  return Model
}
