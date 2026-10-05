import type { Context } from '@deepseek-ai/cordis'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  type ConfigurationSectionProps,
  modelRoutePicker,
  registerConfiguration,
} from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h, useEffect, useRef } from 'react'
export const inject = ['slots', 'locale', 'configForms', 'settingsSchema', 'remote']
export function apply(ctx: Context): void {
  const Route = modelRoutePicker(ctx)
  function Groups(props: ConfigurationSectionProps) {
    const raw = props.getValue('links'),
      groups = raw
        ? raw.split(';').map((group) => group.split('=').map((route) => route.trim()))
        : [],
      report = useRef(props.setError)
    report.current = props.setError
    const invalid =
      groups.length > 128 ||
      new Set(groups.flat()).size !== groups.flat().length ||
      groups.some(
        (group) =>
          group.length < 2 ||
          new Set(group).size !== group.length ||
          group.some((route) => !/^([^/=;\s]+)\/([^=;\s]+)$/.test(route)),
      )
        ? 'Choose at least two distinct provider/model routes in each group.'
        : undefined
    useEffect(() => {
      report.current('links', invalid, 'groups')
      return () => report.current('links', undefined, 'groups')
    }, [invalid])
    const edit = (next: string[][]) =>
      props.setValue('links', next.map((group) => group.join('=')).join(';'))
    return h(
      'section',
      { 'aria-label': 'Linked model groups' },
      h('h3', null, 'Linked model groups'),
      h(
        'p',
        null,
        'Each group identifies equivalent models across providers. Cycling follows the displayed order.',
      ),
      ...groups.map((group, index) =>
        h(
          'div',
          { key: index, className: 'config-editor-row' },
          h('h4', null, `Group ${index + 1}`),
          ...group.map((value, member) =>
            h(Route, {
              key: member,
              value,
              label: `Route ${member + 1}`,
              disabled: props.disabled,
              onChange: (value) =>
                edit(
                  groups.map((row, i) =>
                    i === index ? row.map((route, j) => (j === member ? value : route)) : row,
                  ),
                ),
            }),
          ),
          h(
            Button,
            {
              type: 'button',
              size: 'sm',
              variant: 'outline',
              disabled: props.disabled,
              onClick: () => edit(groups.map((row, i) => (i === index ? [...row, ''] : row))),
            },
            'Add route',
          ),
          h(
            Button,
            {
              type: 'button',
              size: 'sm',
              variant: 'ghost',
              disabled: props.disabled,
              onClick: () => edit(groups.filter((_, i) => i !== index)),
            },
            'Remove group',
          ),
        ),
      ),
      h(
        Button,
        {
          type: 'button',
          size: 'sm',
          variant: 'outline',
          disabled: props.disabled,
          onClick: () => edit([...groups, ['', '']]),
        },
        'Add link group',
      ),
    )
  }
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-command-model-links',
    rowId: 'command-model-links',
    sections: [{ fields: ['links'], component: Groups }],
  })
}
