import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  configurationTheme,
  connectRemote,
  registerConfiguration,
  registerConversationPanel,
  remoteValue,
} from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h, useState } from 'react'
import { contribution, type InspectorView, viewSchema } from '../wire.ts'
export const inject = ['slots', 'locale', 'configForms', 'settingsSchema', 'remote', 'sessions']
export function apply(ctx: Context): void {
  const remote = connectRemote(ctx, 'contextInspector', contribution)
  function Introduction() {
    return h(
      'section',
      null,
      h('h3', null, 'Inspect what the model actually received'),
      h(
        'p',
        null,
        'The conversation inspector shows the last main-agent request in this host generation, message structure, tool names, native token pressure, heuristic envelope size and current retention ranking. External summary bodies and provider credentials are excluded.',
      ),
      h(
        'p',
        null,
        'Text previews are off by default and remain bounded when enabled. Inspection is read only. Metadata unavailable from DSH or a provider stays unknown.',
      ),
    )
  }
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-context-inspector',
    rowId: 'context-inspector',
    before: Introduction,
  })
  function Inspector(props: PropsRuntime<'conversation.input.left'>) {
    const [view, setView] = useState<InspectorView>(),
      [busy, setBusy] = useState(false),
      [error, setError] = useState('')
    const refresh = async () => {
      setBusy(true)
      try {
        setView(viewSchema.parse(remoteValue(await (await remote()).read(props.sessionId))))
        setError('')
      } catch {
        setError(
          'Context inspection is unavailable. Open an active session and enable the host plugin.',
        )
      } finally {
        setBusy(false)
      }
    }
    return h(
      'section',
      { className: 'dsh-plugin-settings dsh-plugin-panel' },
      h('style', null, configurationTheme),
      h(
        Button,
        {
          variant: 'outline',
          size: 'sm',
          type: 'button',
          disabled: busy,
          onClick: () => {
            void refresh()
          },
        },
        busy ? 'Reading context…' : 'Inspect current context',
      ),
      view
        ? h(
            'section',
            { 'aria-label': 'Current model context' },
            h(
              'dl',
              null,
              ...[
                ['Provider/model', `${view.provider ?? 'Unknown'} / ${view.model ?? 'Unknown'}`],
                ['Environment', view.environment],
                ['Evidence state', view.evidenceState],
                [
                  'Context capacity',
                  view.contextWindow === null ? 'Unknown' : String(view.contextWindow),
                ],
                [
                  'Native token pressure',
                  view.requestTokens === null ? 'Unknown' : String(view.requestTokens),
                ],
                [
                  'UTF-8 envelope heuristic',
                  view.envelopeHeuristic === null ? 'Unknown' : String(view.envelopeHeuristic),
                ],
                ['Messages', `${view.messageCount} · ${view.omittedMessages} rows omitted`],
              ].flatMap(([label, value]) => [
                h('dt', { key: `${label}:label` }, label),
                h('dd', { key: `${label}:value` }, value),
              ]),
            ),
            h('p', null, view.estimateKind),
            h('p', null, view.summaryVisibility),
            h(
              'details',
              null,
              h('summary', null, `${view.tools.length} tool definitions`),
              h('p', null, view.tools.join(', ')),
            ),
            h(
              'ol',
              null,
              ...view.messages.map((row, index) =>
                h(
                  'li',
                  { key: index },
                  h(
                    'strong',
                    null,
                    `${row.role} · ${row.blocks.join(', ')} · ${row.characters} text characters`,
                  ),
                  row.preview
                    ? h(
                        'pre',
                        { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
                        row.preview,
                      )
                    : null,
                ),
              ),
            ),
            h(
              'details',
              null,
              h('summary', null, 'Current retention ranking'),
              h(
                'ul',
                null,
                ...view.retention.map((unit) =>
                  h(
                    'li',
                    { key: unit.id },
                    `${unit.kind} · ${unit.mandatory ? 'mandatory' : `importance ${unit.importance ?? 'unknown'}`} · events ${unit.seqs.join(', ')} · ${unit.reasons.join(', ')}`,
                  ),
                ),
              ),
            ),
            h(
              'details',
              null,
              h('summary', null, 'Recorded compaction ranges'),
              h(
                'ul',
                null,
                ...view.prunedRanges.map((row, index) =>
                  h(
                    'li',
                    { key: index },
                    `Events ${row.seqs.join(', ')} · ${row.tokens} native shadow tokens`,
                  ),
                ),
              ),
            ),
          )
        : null,
      error ? h('p', { role: 'status' }, error) : null,
    )
  }
  registerConversationPanel(ctx, {
    id: 'context-inspector',
    label: 'Context inspector',
    order: 30,
    component: Inspector,
  })
}
