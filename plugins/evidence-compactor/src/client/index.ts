import type { Context } from '@deepseek-ai/cordis'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  configurationModel,
  connectRemote,
  registerConfiguration,
  remoteValue,
} from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h, useEffect, useState } from 'react'
import { controlContribution, type EvidenceView, parseEvidenceView } from '../control-wire.ts'
export const inject = ['slots', 'locale', 'configForms', 'settingsSchema', 'remote']

export function apply(ctx: Context): void {
  const control = connectRemote(ctx, 'evidenceControl', controlContribution)
  function Status() {
    const [view, setView] = useState<EvidenceView>()
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    useEffect(() => {
      let live = true
      const refresh = () => {
        void control()
          .then((remote) => remote.state())
          .then((result) => {
            const view = parseEvidenceView(remoteValue(result))
            if (live) {
              setView(view)
              setError('')
            }
          })
          .catch(() => {
            if (live) setError('Enable the plugin to read compactor status.')
          })
      }
      refresh()
      const timer = setInterval(refresh, 3000)
      return () => {
        live = false
        clearInterval(timer)
      }
    }, [])
    const install = async () => {
      setBusy(true)
      try {
        setView(parseEvidenceView(remoteValue(await (await control()).install())))
        setError('')
      } catch {
        setError('Preset replacement could not be requested.')
      } finally {
        setBusy(false)
      }
    }
    return h(
      'section',
      { 'aria-label': 'Compactor status' },
      h('h3', null, 'Native context compaction'),
      h(
        'p',
        null,
        view?.installed.length
          ? `Updated presets: ${view.installed.join(', ')}.`
          : 'The selected presets have not yet been replaced.',
      ),
      h(
        'p',
        null,
        'Existing agents retain their preset revision. Reopen their sessions after installing the backend.',
      ),
      view
        ? h(
            'p',
            null,
            `${view.workspaces} open workspace archives · ${view.sessions} session ledgers · extraction ${view.extractionEnabled ? 'enabled' : 'disabled'}`,
          )
        : null,
      h(
        Button,
        {
          type: 'button',
          disabled: busy || view?.installing,
          onClick: () => {
            void install()
          },
        },
        busy || view?.installing ? 'Updating presets…' : 'Install in selected presets',
      ),
      error || view?.error ? h('p', { role: 'status' }, error || view?.error) : null,
    )
  }
  const Model = configurationModel(ctx, {
    providerField: 'extractionProvider',
    modelField: 'extractionModel',
    title: 'Background extraction model',
    description:
      'Select any model advertised by DSH. Its provider credential is configured in that provider’s Plugins page. Evidence stays local until extraction is enabled below.',
  })
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-evidence-compactor',
    rowId: 'evidence-compactor',
    before: Status,
    sections: [{ fields: ['extractionProvider', 'extractionModel'], component: Model }],
  })
}
