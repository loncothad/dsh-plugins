import type { Context } from '@deepseek-ai/cordis'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  type ConfigurationSectionProps,
  modelRoutePicker,
  registerConfiguration,
} from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h, useEffect, useRef } from 'react'
import { parseChains } from '../chains.ts'
export const inject = ['slots', 'locale', 'configForms', 'settingsSchema', 'remote']
export function apply(ctx: Context): void {
  const Route = modelRoutePicker(ctx)
  function Chains(props: ConfigurationSectionProps) {
    let chains: string[] = []
    let error: string | undefined
    try {
      chains = JSON.parse(props.getValue('chains') || '[]')
      if (
        !Array.isArray(chains) ||
        chains.some((row) => typeof row !== 'string') ||
        chains.length > 64
      )
        throw new Error('Choose up to 64 routes')
      parseChains(chains)
    } catch {
      error = 'Each chain needs a primary provider/model and at least one fallback.'
    }
    const report = useRef(props.setError)
    report.current = props.setError
    useEffect(() => {
      report.current('chains', error, 'routes')
      return () => report.current('chains', undefined, 'routes')
    }, [error])
    const edit = (next: string[]) => props.setValue('chains', JSON.stringify(next))
    return h(
      'section',
      { 'aria-label': 'Fallback chains' },
      h('h3', null, 'Fallback chains'),
      h(
        'p',
        null,
        'Choose the failing primary route, then its fallback models in order. Only configured failure codes advance the chain.',
      ),
      ...chains.map((chain, index) => {
        const routes = chain.split('>').map((route) => route.trim()),
          update = (position: number, value: string) =>
            edit(
              chains.map((row, i) =>
                i === index
                  ? routes.map((route, j) => (j === position ? value : route)).join(' > ')
                  : row,
              ),
            )
        return h(
          'div',
          { key: index, className: 'config-editor-row' },
          h('h4', null, `Chain ${index + 1}`),
          ...routes.map((route, position) => {
            const [base, effort = ''] = route.split('=')
            return h(
              'div',
              { key: position },
              h(Route, {
                label: position === 0 ? 'Primary route' : `Fallback ${position}`,
                allowAny: position === 0,
                value: base ?? '',
                disabled: props.disabled,
                onChange: (value) => update(position, `${value}${effort ? `=${effort}` : ''}`),
              }),
              position > 0
                ? h(
                    'label',
                    null,
                    'Reasoning effort (optional)',
                    h(Input, {
                      className: 'config-input',
                      value: effort,
                      disabled: props.disabled,
                      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                        update(
                          position,
                          `${base}${event.target.value ? `=${event.target.value}` : ''}`,
                        ),
                    }),
                  )
                : null,
              position > 0
                ? h(
                    Button,
                    {
                      type: 'button',
                      size: 'sm',
                      variant: 'ghost',
                      disabled: props.disabled,
                      onClick: () =>
                        edit(
                          chains.map((row, i) =>
                            i === index ? routes.filter((_, j) => j !== position).join(' > ') : row,
                          ),
                        ),
                    },
                    'Remove fallback',
                  )
                : null,
            )
          }),
          h(
            Button,
            {
              type: 'button',
              size: 'sm',
              variant: 'outline',
              disabled: props.disabled,
              onClick: () => edit(chains.map((row, i) => (i === index ? `${row} > ` : row))),
            },
            'Add fallback',
          ),
          h(
            Button,
            {
              type: 'button',
              size: 'sm',
              variant: 'ghost',
              disabled: props.disabled,
              onClick: () => edit(chains.filter((_, i) => i !== index)),
            },
            'Remove chain',
          ),
        )
      }),
      h(
        Button,
        {
          type: 'button',
          size: 'sm',
          variant: 'outline',
          disabled: props.disabled,
          onClick: () => edit([...chains, ' > ']),
        },
        'Add fallback chain',
      ),
    )
  }
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-fallback-router',
    rowId: 'fallback-router',
    sections: [{ fields: ['chains'], component: Chains }],
  })
}
