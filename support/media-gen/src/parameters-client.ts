/** Typed controls and the advanced JSON field edit the same operator default map. */
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement as h, useEffect, useRef, useState } from 'react'
import type { MediaCatalogModel, MediaParameter } from './media.ts'
import { modelDefaults, validateModelOptions } from './options.ts'
import { mediaProperties } from './schema.ts'
export interface MediaDraftProps {
  getValue(field: string): string
  setValue(field: string, value: string): void
  setError(field: string, error: string | undefined, source: string): void
  disabled: boolean
}
export function MediaParameters({
  model,
  modelId,
  source,
  ...props
}: MediaDraftProps & { model?: MediaCatalogModel; modelId: string; source: string }) {
  const reportError = useRef(props.setError)
  reportError.current = props.setError
  const raw = props.getValue('mediaModelOptions')
  let defaults: ReturnType<typeof modelDefaults> = {},
    error: string | undefined,
    malformed = false
  try {
    defaults = modelDefaults(JSON.parse(raw))
  } catch {
    malformed = true
    error = 'Media model options must be valid bounded JSON option objects.'
  }
  const current = defaults[modelId] ?? {}
  const properties = model?.inputSchema ? mediaProperties(model.inputSchema) : {}
  const sources = new Set([
    'prompt',
    'text',
    'input',
    'image_url',
    'image_urls',
    'audio_url',
    'audio_urls',
    'video_url',
    'video_urls',
    'model_url',
    'model',
    'input_audio',
    'provider',
    'input_references',
  ])
  const schemaControls = Object.entries(properties).filter(([name]) => !sources.has(name))
  if (!error && model) error = validateModelOptions(model, current)
  useEffect(() => {
    reportError.current('mediaModelOptions', error, source)
  }, [error, source])
  useEffect(() => () => reportError.current('mediaModelOptions', undefined, source), [source])
  if (!modelId) return error ? h('p', { role: 'alert' }, error) : null
  const change = (name: string, value: unknown) => {
    const options = { ...current }
    if (value === undefined) delete options[name]
    else options[name] = value
    const next = { ...defaults }
    if (Object.keys(options).length) next[modelId] = options
    else delete next[modelId]
    props.setValue('mediaModelOptions', JSON.stringify(next))
  }
  const control = (name: string, parameter: MediaParameter) => {
    const present = Object.hasOwn(current, name),
      value = current[name]
    const values = parameter.values ?? (parameter.type === 'boolean' ? [true, false] : undefined)
    const label = `${modelId}: ${name}`
    const common = {
      'aria-label': label,
      disabled: props.disabled || malformed,
      style: { width: '100%', margin: '6px 0' },
    }
    const editor = values
      ? h(
          'select',
          {
            ...common,
            value: present ? JSON.stringify(value) : '',
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
              change(name, event.target.value ? JSON.parse(event.target.value) : undefined),
          },
          h('option', { value: '' }, 'Provider default'),
          present && !values.includes(value as string | number | boolean)
            ? h(
                'option',
                { value: JSON.stringify(value) },
                `${String(value)} (no longer advertised)`,
              )
            : null,
          ...values.map((value) =>
            h(
              'option',
              { key: JSON.stringify(value), value: JSON.stringify(value) },
              String(value),
            ),
          ),
        )
      : h(Input, {
          className: 'config-input',
          ...common,
          type: parameter.type === 'number' ? 'number' : 'text',
          step: parameter.type === 'number' ? 'any' : undefined,
          value: present ? String(value) : '',
          placeholder: 'Provider default',
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
            const raw = event.target.value
            if (raw === '') change(name, undefined)
            else if (parameter.type === 'number') {
              const parsed = Number(raw)
              if (Number.isFinite(parsed)) change(name, parsed)
            } else change(name, raw)
          },
        })
    return h(
      'div',
      { key: name },
      h('label', null, name, editor),
      present
        ? h(
            Button,
            { type: 'button', disabled: props.disabled, onClick: () => change(name, undefined) },
            'Use provider default',
          )
        : null,
    )
  }
  return h(
    'section',
    { 'aria-label': `Parameters for ${modelId}` },
    h('h4', null, 'Saved model parameters'),
    ...schemaControls.map(([name, raw]) => {
      const schema = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      if (['string', 'number', 'integer', 'boolean'].includes(String(schema.type)))
        return control(name, {
          type: schema.type === 'integer' ? 'number' : (schema.type as MediaParameter['type']),
          ...(Array.isArray(schema.enum)
            ? { values: schema.enum as (string | number | boolean)[] }
            : {}),
        })
      return h(JsonParameter, {
        key: `${modelId}:${name}`,
        name,
        label: `${modelId}: ${name}`,
        value: Object.hasOwn(current, name) ? JSON.stringify(current[name], null, 2) : '',
        disabled: props.disabled || malformed,
        change: (value) => change(name, value),
        error: (value) => props.setError('mediaModelOptions', value, `${source}:${name}`),
        description: typeof schema.description === 'string' ? schema.description : undefined,
      })
    }),
    ...(!error || model
      ? Object.entries(model?.parameters ?? {}).map(([name, parameter]) => control(name, parameter))
      : []),
    !schemaControls.length && (!model?.parameters || !Object.keys(model.parameters).length)
      ? h(
          'p',
          null,
          'No option schema is advertised. Use advanced JSON only for documented provider parameters.',
        )
      : null,
    h(
      'p',
      null,
      'Overrides apply to this model in both generation tools and human commands. Provider-specific parameters remain available in the advanced JSON field.',
    ),
    error && !malformed ? h('p', { role: 'alert' }, error) : null,
  )
}

function JsonParameter(props: {
  name: string
  label: string
  value: string
  disabled: boolean
  change(value: unknown): void
  error(value: string | undefined): void
  description?: string
}) {
  const reportError = useRef(props.error)
  reportError.current = props.error
  const [draft, setDraft] = useState(props.value)
  const [error, setError] = useState<string>()
  useEffect(() => {
    setDraft(props.value)
  }, [props.value])
  useEffect(() => {
    reportError.current(error)
    return () => reportError.current(undefined)
  }, [error])
  return h(
    'div',
    null,
    h(
      'label',
      null,
      props.name,
      h('textarea', {
        style: {
          width: '100%',
          padding: '10px 12px',
          boxSizing: 'border-box',
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l4)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
        },
        'aria-label': props.label,
        value: draft,
        rows: 4,
        disabled: props.disabled,
        placeholder: 'JSON value; leave empty for the provider default',
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
          const raw = event.target.value
          setDraft(raw)
          try {
            const parsed: unknown = raw ? JSON.parse(raw) : undefined
            props.change(parsed)
            setError(undefined)
          } catch {
            setError(`Invalid JSON for ${props.name}`)
          }
        },
      }),
    ),
    props.description ? h('p', null, props.description) : null,
    error ? h('p', { role: 'alert' }, error) : null,
  )
}
