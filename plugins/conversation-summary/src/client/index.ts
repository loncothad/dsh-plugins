import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { Button, MarkdownText, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  configurationModel,
  configurationTheme,
  connectRemote,
  privateStateClient,
  registerConfiguration,
  registerConversationPanel,
  remoteValue,
} from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'
import { contentContribution } from '../content-wire.ts'
import { type Receipt, stateSchema } from '../domain.ts'
export const inject = [
  'slots',
  'locale',
  'configForms',
  'settingsSchema',
  'remote',
  'remote.commands',
  'sessions',
]
function SummaryCard({
  row,
  read,
}: {
  row: Receipt
  read: (sessionId: string, reference: string) => Promise<string>
}) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState(''),
    [text, setText] = useState(row.text ?? ''),
    [expanded, setExpanded] = useState(false),
    [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!expanded || !row.externalRef || text) return
    let live = true
    setLoading(true)
    void read(row.sessionId, row.externalRef)
      .then((value) => {
        if (live) {
          setLoading(false)
          setText(value)
          setError('')
        }
      })
      .catch(() => {
        if (live)
          setError(
            'This private summary result is unavailable. Its covered range is still recorded; no text was imported into the model context.',
          )
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [expanded, row.externalRef, row.sessionId, read, text])
  return h(
    'article',
    { 'aria-label': 'Conversation summary', className: 'dsh-plugin-settings config-summary-card' },
    h('style', null, configurationTheme),
    h(
      'header',
      null,
      h('strong', null, 'Conversation summary'),
      h('span', { className: 'config-badge' }, 'Private summary'),
      h(
        'p',
        null,
        row.origin === 'external-model'
          ? `Unverified model summary · ${row.provider} / ${row.model}`
          : 'Local transcript digest',
      ),
      h(
        'p',
        null,
        `Events ${row.fromSeq}–${row.throughSeq} · ${row.turns} completed turns · ${row.trigger} · ${new Date(row.createdAt).toLocaleString()}`,
      ),
    ),
    h('p', null, 'Visible to you. Excluded from the main model context and compaction.'),
    row.pending
      ? h(
          'p',
          { role: 'status' },
          'This card covers a contiguous prefix. More conversation evidence remains for the next summary.',
        )
      : null,
    h(
      'details',
      {
        onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) =>
          setExpanded(event.currentTarget.open),
      },
      h('summary', { style: { cursor: 'pointer' } }, 'Read summary'),
      loading
        ? h('p', { role: 'status' }, 'Loading private summary…')
        : h(MarkdownText, {
            text,
            variant: 'compact',
            labels: {
              code: { copyLabel: 'Copy code', copiedLabel: 'Copied' },
              footnotes: 'Footnotes',
            },
          }),
    ),
    h(
      Button,
      {
        variant: 'outline',
        size: 'sm',
        type: 'button',
        disabled: !text || loading,
        onClick: () => {
          void writeClipboard(text)
            .then((ok) => {
              setCopied(ok)
              setError(
                ok ? '' : 'Clipboard access was unavailable. Select the summary text to copy it.',
              )
            })
            .catch(() =>
              setError('Clipboard access was unavailable. Select the summary text to copy it.'),
            )
        },
      },
      copied ? 'Copied' : 'Copy summary',
    ),
    error ? h('p', { role: 'status' }, error) : null,
  )
}
export function apply(ctx: Context): void {
  const content = connectRemote(ctx, 'conversationSummaryContent', contentContribution)
  const read = async (sessionId: string, reference: string) =>
    remoteValue(await (await content()).read(sessionId, reference))
  const useSummary = privateStateClient(ctx, 'conversationSummary', (value) =>
    stateSchema.parse(value),
  )
  const SummaryModel = configurationModel(ctx, {
    providerField: 'summaryProvider',
    modelField: 'summaryModel',
    title: 'Summary model',
    description:
      'Any registered text model. Enable Model generation below to send covered evidence to this provider. Credentials are configured in its own Plugins page.',
  })
  const DecisionModel = configurationModel(ctx, {
    providerField: 'decisionProvider',
    modelField: 'decisionModel',
    title: 'Delivery decision model',
    description:
      'Choose any registered text model to decide whether progress merits a summary. It returns SEND or WAIT; its reasoning is never inserted into the conversation.',
  })
  function DecisionControls(
    props: import('@loncothad/dsh-plugin-runtime/client').ConfigurationSectionProps,
  ) {
    return props.getValue('decisionSource') === 'plugin'
      ? h(
          'p',
          null,
          'Delivery decisions use the backend configured in Decision Models. Configure Cloudflare, OpenRouter Decisions or TypeSafe there.',
        )
      : h(DecisionModel, props)
  }
  function Introduction() {
    return h(
      'section',
      null,
      h('h3', null, 'Summaries for the reader'),
      h(
        'p',
        null,
        'Summaries appear as expandable cards in this conversation. Each card covers progress since the last successful delivery. External model text is never added to the main agent’s messages or compaction evidence.',
      ),
      h(
        'p',
        null,
        'Use /summary now, /summary status or /summary cancel. Automatic delivery and model signaling are off by default. Local generation needs no credentials. Model generation and decisions send evidence to their chosen providers and may incur charges.',
      ),
    )
  }
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-conversation-summary',
    rowId: 'conversation-summary',
    before: Introduction,
    sections: [
      { fields: ['summaryProvider', 'summaryModel'], component: SummaryModel },
      { fields: ['decisionProvider', 'decisionModel'], component: DecisionControls },
    ],
  })
  const summaryForm = ctx.configForms.get<Record<string, unknown>>('conversation-summary')
  function Controls(props: PropsRuntime<'conversation.input.left'>) {
    const state = useSummary(props.sessionId)
    const config = useSyncExternalStore(
      (listener) => summaryForm.subscribe(listener),
      () => summaryForm.getSnapshot(),
    )
    const [busy, setBusy] = useState(false),
      [message, setMessage] = useState('')
    const execute = async (action: string) => {
      setBusy(true)
      try {
        const result = await ctx.remote.commands.execute(props.sessionId, `/summary ${action}`, [])
        if (!result.ok) throw new Error(result.error.message)
        if (!result.value) throw new Error('Enable the summary command in Plugins.')
        if (result.value.result.kind === 'error') throw Error(result.value.result.text)
        setMessage(
          action === 'now'
            ? 'Summary prepared.'
            : action === 'cancel'
              ? 'Summary cancelled.'
              : (result.value.result.text ?? 'Updated.'),
        )
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Summary request failed.')
      } finally {
        setBusy(false)
      }
    }
    const configure = async (key: string, value: string | number) => {
      setBusy(true)
      setMessage('')
      try {
        const accepted = await summaryForm.mutate(
          [{ op: 'set', path: [key], value }],
          config.revision,
        )
        setMessage(
          accepted
            ? 'Summary default saved for all chats.'
            : 'Settings changed elsewhere. Reload before saving.',
        )
      } catch {
        setMessage('Could not save summary settings.')
      } finally {
        setBusy(false)
      }
    }
    return h(
      'div',
      { className: 'dsh-plugin-settings dsh-plugin-panel' },
      h('style', null, configurationTheme),
      h(
        'header',
        null,
        h('h3', null, 'Recent progress, for you'),
        h(
          'p',
          null,
          'Private cards stay outside main-model context and compaction. Each new summary starts after the last covered event.',
        ),
      ),
      h(
        'dl',
        { className: 'config-summary-status' },
        h('dt', null, 'Last coverage'),
        h(
          'dd',
          null,
          state?.latest
            ? `${state.latest.turns} turns · events ${state.latest.fromSeq}–${state.latest.throughSeq} · ${new Date(state.latest.createdAt).toLocaleString()}`
            : 'No summary yet',
        ),
        h('dt', null, 'Generation'),
        h(
          'dd',
          null,
          config.value?.generation === 'model'
            ? `${config.value.summaryProvider ?? 'Choose provider'} / ${config.value.summaryModel ?? 'Choose model'}`
            : 'Local transcript digest',
        ),
        h('dt', null, 'Automatic delivery'),
        h('dd', null, String(config.value?.automatic ?? 'off')),
      ),
      h(
        'details',
        null,
        h('summary', null, 'Delivery settings'),
        h(
          'p',
          null,
          'These defaults apply to all chats. Select external models and guidance in Plugins > Conversation Summaries.',
        ),
        h(
          'label',
          null,
          'Generate with',
          h(
            'select',
            {
              className: 'config-select',
              value: String(config.value?.generation ?? 'local'),
              disabled: busy || !config.writable,
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
                void configure('generation', e.target.value),
            },
            h('option', { value: 'local' }, 'Local digest, no API call'),
            h('option', { value: 'model' }, 'Selected summary model'),
          ),
        ),
        h(
          'label',
          null,
          'Send automatically',
          h(
            'select',
            {
              className: 'config-select',
              value: String(config.value?.automatic ?? 'off'),
              disabled: busy || !config.writable,
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
                void configure('automatic', e.target.value),
            },
            ...['off', 'turns', 'decision', 'turns-or-decision'].map((value) =>
              h(
                'option',
                { key: value, value },
                value === 'off'
                  ? 'On demand only'
                  : value === 'turns'
                    ? 'Every N turns'
                    : value === 'decision'
                      ? 'Decision model'
                      : 'Turns or decision model',
              ),
            ),
          ),
        ),
        h(
          'label',
          null,
          'Turns between summaries',
          h('input', {
            className: 'config-input',
            type: 'number',
            min: 1,
            max: 1000,
            defaultValue: Number(config.value?.everyTurns ?? 5),
            disabled: busy || !config.writable,
            onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
              const value = Number(e.target.value)
              if (
                Number.isInteger(value) &&
                value >= 1 &&
                value <= 1000 &&
                value !== config.value?.everyTurns
              )
                void configure('everyTurns', value)
            },
          }),
        ),
      ),
      !state?.deliveries.length
        ? h(
            'p',
            null,
            'Nothing has been summarized yet. Complete a turn, then summarize its progress.',
          )
        : null,
      ...[...(state?.deliveries ?? [])]
        .reverse()
        .map((row) => h(SummaryCard, { key: row.id, row, read })),
      h(
        Button,
        {
          variant: 'primary',
          size: 'sm',
          type: 'button',
          disabled: busy,
          onClick: () => {
            void execute('now')
          },
        },
        busy ? 'Preparing summary…' : 'Summarize recent progress',
      ),
      busy
        ? h(
            Button,
            {
              variant: 'outline',
              size: 'sm',
              type: 'button',
              onClick: () => {
                void execute('cancel')
              },
            },
            'Cancel summary',
          )
        : null,
      state?.error ? h('p', { role: 'status' }, state.error) : null,
      message ? h('p', { role: 'status' }, message) : null,
    )
  }
  function Count(props: PropsRuntime<'conversation.input.left'>) {
    const state = useSummary(props.sessionId)
    const count = state?.deliveries.length ?? 0
    return count
      ? h(
          'small',
          { className: 'dsh-session-tool-count', 'aria-label': `${count} private summaries` },
          String(count),
        )
      : null
  }
  registerConversationPanel(ctx, {
    id: 'conversation-summary',
    label: 'Summaries',
    order: 20,
    component: Controls,
    badge: Count,
  })
}
