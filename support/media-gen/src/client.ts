/** Compact task rows with a searchable, priced native model chooser. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  configurationTheme,
  connectRemote,
  remoteValue,
} from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h, useEffect, useState } from 'react'
import {
  type MediaCatalogNamespace,
  type MediaCatalogPage,
  type MediaCatalogSort,
  mediaCatalogContribution,
} from './catalog-wire.ts'
import type { MediaCatalogModel, MediaModality } from './media.ts'
import { type MediaDraftProps, MediaParameters } from './parameters-client.ts'

type DraftProps = MediaDraftProps
function utcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}
function releaseLabel(model: MediaCatalogModel): string {
  return model.releasedAt === undefined
    ? 'Release date unknown'
    : `Released on fal ${utcDate(model.releasedAt)}`
}
export function mediaModelControls(
  ctx: Context,
  namespace: MediaCatalogNamespace,
  fields: readonly { field: string; output: MediaModality; label: string }[],
): React.ComponentType<DraftProps> {
  const mount = connectRemote(ctx, namespace, mediaCatalogContribution(namespace))
  function Model({
    field,
    output,
    label,
    getValue,
    setValue,
    setError,
    disabled,
  }: DraftProps & (typeof fields)[number]) {
    const selected = getValue(field),
      [open, setOpen] = useState(false),
      [page, setPage] = useState<MediaCatalogPage>({ models: [], total: 0 }),
      [query, setQuery] = useState(''),
      [offset, setOffset] = useState(0),
      [sort, setSort] = useState<MediaCatalogSort>(
        namespace === 'falMediaCatalog' ? 'newest' : 'provider',
      ),
      [revision, setRevision] = useState(0),
      [error, setErrorState] = useState(''),
      [loading, setLoading] = useState(false),
      [described, setDescribed] = useState<MediaCatalogModel>()
    // biome-ignore lint/correctness/useExhaustiveDependencies: Manual refresh re-fetches both the selected schema and the catalog.
    useEffect(() => {
      let live = true
      setDescribed(undefined)
      if (selected)
        void mount()
          .then((remote) => remote.describe(selected))
          .then((result) => {
            if (live) setDescribed(remoteValue(result))
          })
          .catch(() => {
            if (live)
              setErrorState(
                'Model schema unavailable. Check provider access or refresh the catalog.',
              )
          })
      return () => {
        live = false
      }
    }, [selected, revision])
    // biome-ignore lint/correctness/useExhaustiveDependencies: Manual refresh re-fetches both the selected schema and the catalog.
    useEffect(() => {
      if (!open) return
      let live = true
      const timer = setTimeout(() => {
        setLoading(true)
        setErrorState('')
        void mount()
          .then((remote) => remote.list(output, query, offset, sort))
          .then((result) => {
            if (live) setPage(remoteValue(result))
          })
          .catch(() => {
            if (live)
              setErrorState('Could not load models. Check the provider credential and retry.')
          })
          .finally(() => {
            if (live) setLoading(false)
          })
      }, 200)
      return () => {
        live = false
        clearTimeout(timer)
      }
    }, [open, query, offset, revision, output, sort])
    const model = described ?? page.models.find((row) => row.id === selected)
    const choose = (id: string) => {
      setValue(field, id)
      setOpen(false)
    }
    return h(
      'section',
      { className: 'dsh-media-task', 'aria-label': label },
      h(
        'div',
        { className: 'dsh-media-task-head' },
        h(
          'div',
          null,
          h('h4', null, label),
          h('p', null, model?.name ?? (selected || 'Choose a model for each request')),
        ),
        h(
          Button,
          {
            variant: 'outline',
            size: 'sm',
            disabled,
            onClick: () => setOpen(true),
            'aria-label': `Choose ${label}`,
          },
          selected ? 'Change model' : 'Choose model',
        ),
      ),
      model
        ? h(
            'p',
            null,
            model.pricing ?? 'Price unknown',
            ` · ${(model.inputs ?? ['text']).join(' + ')} → ${model.outputs.join(' + ')}`,
          )
        : null,
      model?.unavailableReason ? h('p', { role: 'alert' }, model.unavailableReason) : null,
      namespace === 'falMediaCatalog' && model ? h('p', null, releaseLabel(model)) : null,
      selected
        ? h(
            'details',
            null,
            h('summary', null, 'Model parameters and details'),
            model?.description ? h('p', null, model.description) : null,
            model?.updatedAt !== undefined
              ? h('p', null, `Metadata updated ${utcDate(model.updatedAt)}`)
              : null,
            h(
              'p',
              null,
              `Protocol: ${model?.protocol ?? 'unknown'} · ${model?.fetchedAt ? `Catalog observed ${new Date(model.fetchedAt).toLocaleString()}` : 'Catalog freshness unknown'}`,
            ),
            h(MediaParameters, {
              model,
              modelId: selected,
              source: field,
              getValue,
              setValue,
              setError,
              disabled,
            }),
          )
        : null,
      h(
        Modal,
        {
          open,
          onClose: () => setOpen(false),
          title: `Choose ${label.toLowerCase()}`,
          closeLabel: 'Close model chooser',
          className: 'dsh-media-picker',
          contentClassName: 'dsh-media-picker-content',
        },
        h(
          'style',
          null,
          `${configurationTheme}\n.dsh-media-picker{width:min(760px,100%);max-height:100%;}.dsh-media-picker-content{min-height:0;overflow:auto;}.dsh-media-candidates{display:flex;flex-direction:column;max-height:390px;overflow:auto;border-top:0.5px solid var(--dsw-alias-border-l2);}.dsh-media-candidate{display:block;width:100%;text-align:left;border:0;border-bottom:0.5px solid var(--dsw-alias-border-l2);background:transparent;padding:12px 4px;cursor:pointer;color:var(--dsw-alias-label-primary);font:inherit;}.dsh-media-candidate:hover,.dsh-media-candidate:focus-visible{background:var(--dsw-alias-interactive-bg-hover);}.dsh-media-candidate-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;}.dsh-media-candidate small{display:block;margin-top:4px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;font-size:12px;}.dsh-media-candidate p{margin:6px 0 0;}.dsh-media-price{font-size:12px;color:var(--dsw-alias-label-secondary);}.dsh-media-sort{display:flex;align-items:center;gap:12px;margin:12px 0;}.dsh-media-sort select{width:auto;min-width:150px;max-width:100%;}.dsh-media-pagination{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;}`,
        ),
        h(
          'div',
          { className: 'dsh-plugin-settings' },
          h(Input, {
            className: 'config-input',
            type: 'search',
            'aria-label': `Search ${label}`,
            value: query,
            maxLength: 256,
            ...{ 'data-modal-autofocus': true },
            placeholder: 'Search name or model ID',
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              setQuery(event.target.value)
              setOffset(0)
            },
          }),
          h(
            'p',
            null,
            'Prices use each model’s advertised billing unit and can vary with request options. No media is generated when choosing a model.',
          ),
          h(
            'label',
            { className: 'dsh-media-sort' },
            'Sort models',
            h(
              'select',
              {
                className: 'config-select',
                'aria-label': 'Sort models',
                value: sort,
                onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
                  setSort(event.target.value as MediaCatalogSort)
                  setOffset(0)
                },
              },
              h('option', { value: 'newest' }, 'Newest first'),
              h('option', { value: 'name' }, 'Name'),
              h('option', { value: 'provider' }, 'Provider order'),
            ),
          ),
          namespace === 'falMediaCatalog'
            ? h(
                'small',
                null,
                'Release dates are model creation dates reported by fal. Unknown dates appear last; metadata updates do not change release order.',
              )
            : null,
          h(
            'div',
            {
              className: 'dsh-media-candidates',
              role: 'listbox',
              'aria-label': `${label} choices`,
              onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                const options = [
                    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      'button[role=option]:not(:disabled)',
                    ),
                  ],
                  index = options.indexOf(document.activeElement as HTMLButtonElement)
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? options.length - 1
                      : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) %
                        options.length
                event.preventDefault()
                options[next]?.focus()
              },
            },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-media-candidate',
                role: 'option',
                'aria-selected': !selected,
                onClick: () => choose(''),
              },
              h('strong', null, 'Choose per request'),
              h('small', null, 'No default model.'),
            ),
            ...page.models.slice(0, 20).map((row) =>
              h(
                'button',
                {
                  key: row.id,
                  type: 'button',
                  className: 'dsh-media-candidate',
                  role: 'option',
                  'aria-selected': row.id === selected,
                  disabled: Boolean(row.unavailableReason),
                  onClick: () => choose(row.id),
                },
                h(
                  'span',
                  { className: 'dsh-media-candidate-head' },
                  h('strong', null, row.name),
                  h('span', { className: 'dsh-media-price' }, row.pricing ?? 'Price unknown'),
                ),
                h('small', null, row.id),
                namespace === 'falMediaCatalog'
                  ? h(
                      'small',
                      { className: 'dsh-media-release', 'data-release-at': row.releasedAt },
                      releaseLabel(row),
                    )
                  : null,
                h(
                  'small',
                  null,
                  `${(row.inputs ?? ['text']).join(' + ')} → ${row.outputs.join(' + ')} · ${row.protocol ?? 'Protocol unknown'}`,
                ),
                row.description
                  ? h(
                      'p',
                      null,
                      row.description.length > 180
                        ? `${row.description.slice(0, 177)}…`
                        : row.description,
                    )
                  : null,
                row.unavailableReason ? h('small', null, row.unavailableReason) : null,
              ),
            ),
          ),
          h(
            'div',
            { className: 'dsh-media-pagination' },
            h(
              Button,
              {
                variant: 'ghost',
                size: 'sm',
                disabled: loading || !offset,
                onClick: () => setOffset(Math.max(0, offset - 20)),
              },
              'Previous',
            ),
            h(
              'small',
              { role: 'status' },
              loading
                ? 'Loading models…'
                : error ||
                    `${page.total} models · ${page.models.length ? offset + 1 : 0}–${Math.min(offset + 20, page.total)}`,
            ),
            h(
              Button,
              {
                variant: 'ghost',
                size: 'sm',
                disabled: loading || offset + 20 >= page.total,
                onClick: () => setOffset(offset + 20),
              },
              'Next',
            ),
          ),
          h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              disabled: loading,
              onClick: () => setRevision(revision + 1),
            },
            'Refresh catalog',
          ),
          h(
            'small',
            null,
            page.models[0]?.fetchedAt
              ? `Observed ${new Date(page.models[0].fetchedAt).toLocaleString()}; cached data may be stale.`
              : 'Catalog freshness unknown.',
          ),
        ),
      ),
    )
  }
  return function Models(props: DraftProps) {
    return h(
      'section',
      null,
      h(
        'style',
        null,
        `.dsh-media-task{padding:14px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2);}.dsh-media-task-head{display:flex;align-items:center;justify-content:space-between;gap:16px;}.dsh-media-task h4{margin:0;font-size:13px;}.dsh-media-task p{margin:4px 0;}.dsh-media-task details{margin-top:8px;}.dsh-media-task summary{font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;}`,
      ),
      h('h3', null, 'Default media models'),
      ...fields.map((field) => h(Model, { key: field.field, ...field, ...props })),
      h(
        'details',
        null,
        h('summary', null, 'Shared parameter defaults'),
        h(MediaParameters, { ...props, modelId: '', source: 'all-defaults' }),
      ),
    )
  }
}
