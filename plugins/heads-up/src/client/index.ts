import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button, MarkdownText, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  configurationModel,
  configurationTheme,
  privateStateClient,
  registerConfiguration,
  registerConversationPanel,
} from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h, useState } from 'react'
import { type Notice, stateSchema } from '../state.ts'
export const inject = [
  'slots',
  'locale',
  'configForms',
  'settingsSchema',
  'remote',
  'remote.commands',
  'sessions',
]
export function apply(ctx: Context) {
  const useStateOf = privateStateClient(ctx, 'headsUp', (value) => stateSchema.parse(value))
  const Reviewer = configurationModel(ctx, {
    providerField: 'reviewerProvider',
    modelField: 'reviewerModel',
    title: 'Independent reviewer',
    description:
      'Any registered text model. Credentials stay in its provider plugin. Review runs without tools and never changes the main agent.',
  })
  function Intro() {
    return h(
      'section',
      null,
      h('h3', null, 'Useful things you might miss'),
      h(
        'p',
        null,
        'Heads Up watches main-agent and subagent work. Local checks flag explicit missing verification and suspicious test changes. An optional independent model reviews wider risks. Notices are advisory, with quoted sources; they do not authorize actions or prove misconduct.',
      ),
      h(
        'p',
        null,
        'Use /heads-up review or open Heads Up in Session tools. Acknowledge keeps a notice in history; dismiss hides it; discuss sends it to the main chat for investigation. Private notices stay outside main-model context and compaction until you discuss them.',
      ),
    )
  }
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-heads-up',
    rowId: 'heads-up',
    before: Intro,
    sections: [{ fields: ['reviewerProvider', 'reviewerModel'], component: Reviewer }],
    groups: [
      {
        title: 'Observe work',
        description:
          'Choose whose work is reviewed and when. Completed turns are also review boundaries.',
        fields: [
          'automatic',
          'reviewMain',
          'reviewSubagents',
          'everyEvents',
          'debounceMs',
          'includeToolOutputs',
          'includeLatestUserRequest',
          'workspaceDiffs',
        ],
      },
      {
        title: 'Review and notices',
        description: 'Model review is opt-in. Evidence never changes the reviewer’s instructions.',
        fields: [
          'modelEnabled',
          'reviewerEffort',
          'requireDifferentModel',
          'reviewerGuidance',
          'categories',
          'minimumSeverity',
          'maxNotices',
        ],
      },
      {
        title: 'Review limits',
        description:
          'Prices are operator-supplied estimates. Unknown outcomes retain their reservation; no monetary confidence score is reported.',
        fields: [
          'maxBudgetUsd',
          'inputUsdPerMillion',
          'outputUsdPerMillion',
          'allowUnknownBilling',
          'maxModelCallsPerChat',
          'maxInputCharacters',
          'maxEventCharacters',
          'maxWindowsPerReview',
          'maxOutputTokens',
          'fallbackContextWindow',
          'timeoutMs',
          'maxLiveSources',
          'maxConcurrentJobs',
          'maxQueuedJobs',
        ],
      },
      {
        title: 'Commands and storage',
        description:
          'Disabling a surface prevents its direct use. State belongs to the chat, outside its workspace.',
        fields: ['commandEnabled', 'skillEnabled', 'stateDirectory'],
      },
    ],
  })
  function Panel(props: PropsRuntime<'conversation.input.left'>) {
    const state = useStateOf(props.sessionId),
      [busy, setBusy] = useState(false),
      [message, setMessage] = useState(''),
      [history, setHistory] = useState(false)
    const run = async (action: string) => {
      setBusy(true)
      setMessage('')
      try {
        const response = await ctx.remote.commands.execute(
          props.sessionId,
          `/heads-up ${action}`,
          [],
        )
        if (!response.ok) throw Error(response.error.message)
        if (!response.value) throw Error('Enable the Heads Up command in Plugins.')
        if (response.value.result.kind === 'error') throw Error(response.value.result.text)
        setMessage(response.value.result.text ?? 'Updated.')
      } catch (e) {
        setMessage(e instanceof Error ? e.message : 'Heads Up operation failed.')
      } finally {
        setBusy(false)
      }
    }
    const rows = [...(state?.notices ?? [])]
      .reverse()
      .filter((row) => history || row.state === 'new')
    return h(
      'section',
      { className: 'dsh-plugin-settings dsh-plugin-panel', 'aria-label': 'Heads Up notices' },
      h(
        'style',
        null,
        configurationTheme +
          '\n.dsh-heads-up-card{padding:14px 0;border-top:0.5px solid var(--dsw-alias-border-l2);}.dsh-heads-up-card h4{margin:0 0 6px;}.dsh-heads-up-card pre{max-height:180px;overflow:auto;}.dsh-heads-up-inline{font-size:12px;padding:6px 12px;margin:4px 0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;color:var(--dsw-alias-label-primary);}.dsh-heads-up-inline summary{cursor:pointer;}.dsh-heads-up-inline p{margin:6px 0;overflow-wrap:anywhere;}',
      ),
      h('h3', null, 'Heads Up'),
      h(
        'p',
        null,
        state?.paused
          ? 'Paused for this chat. Existing notices are retained.'
          : 'Private advisory notices. Only “Discuss in chat” shares a concern with the model.',
      ),
      h(
        'small',
        null,
        `${state?.calls ?? 0} model reviews · USD ${(state?.reservedUsd ?? 0).toFixed(4)} reserved${state?.lastReviewAt ? ` · last review ${new Date(state.lastReviewAt).toLocaleString()}` : ''}`,
      ),
      h(
        'div',
        { className: 'config-actions' },
        h(
          Button,
          {
            size: 'sm',
            variant: 'primary',
            disabled: busy || state?.paused,
            onClick: () => void run('review'),
          },
          busy ? 'Reviewing…' : 'Review now',
        ),
        h(
          Button,
          {
            size: 'sm',
            variant: 'outline',
            disabled: busy,
            onClick: () => void run(state?.paused ? 'resume' : 'pause'),
          },
          state?.paused ? 'Resume' : 'Pause',
        ),
        h(
          Button,
          { size: 'sm', variant: 'ghost', onClick: () => void run('cancel') },
          'Cancel review',
        ),
        h(
          Button,
          { size: 'sm', variant: 'ghost', onClick: () => setHistory(!history) },
          history ? 'Show new only' : 'Show history',
        ),
      ),
      !rows.length
        ? h('p', null, 'No notices in this view. Silence does not verify the work.')
        : null,
      ...rows.map((row) => h(Card, { key: row.id, row, busy, run })),
      state?.error ? h('p', { role: 'status' }, state.error) : null,
      message ? h('p', { role: 'status' }, message) : null,
    )
  }
  function Card({
    row,
    busy,
    run,
  }: {
    row: Notice
    busy: boolean
    run: (action: string) => Promise<void>
  }) {
    return h(
      'article',
      { className: 'dsh-heads-up-card', 'aria-label': row.title },
      h('h4', null, row.title),
      h(
        'span',
        { className: 'config-badge' },
        `${row.severity} · ${row.origin === 'model' ? 'Unverified reviewer concern' : 'Recorded observation'} · ${row.state}`,
      ),
      h(MarkdownText, {
        text: row.detail,
        variant: 'compact',
        labels: { code: { copyLabel: 'Copy code', copiedLabel: 'Copied' }, footnotes: 'Footnotes' },
      }),
      h('p', null, `Next check: ${row.nextAction}`),
      h(
        'details',
        null,
        h('summary', null, `${row.sources.length} source${row.sources.length === 1 ? '' : 's'}`),
        ...row.sources.map((source) =>
          h(
            'section',
            { key: source.reference },
            h(
              'small',
              null,
              source.kind === 'workspace-diff'
                ? 'Workspace diff snapshot; author and pre-existing work are unknown'
                : `Session ${source.sessionId} · event ${source.seq}`,
            ),
            h('small', null, 'Bounded excerpt'),
            h('pre', null, source.quote),
            h('small', null, `Evidence hash ${source.hash}`),
            h(
              Button,
              {
                size: 'sm',
                variant: 'ghost',
                onClick: () => void writeClipboard(JSON.stringify(source)),
              },
              'Copy source reference',
            ),
          ),
        ),
      ),
      row.provider ? h('small', null, `${row.provider} / ${row.model}`) : null,
      h(
        'div',
        { className: 'config-actions' },
        h(
          Button,
          {
            size: 'sm',
            variant: 'outline',
            disabled: busy || row.state !== 'new',
            onClick: () => void run(`acknowledge ${row.id}`),
          },
          'Understood',
        ),
        h(
          Button,
          {
            size: 'sm',
            variant: 'outline',
            disabled: busy || row.state === 'discussed',
            onClick: () => void run(`discuss ${row.id}`),
          },
          'Discuss in chat',
        ),
        h(
          Button,
          {
            size: 'sm',
            variant: 'ghost',
            disabled: busy || row.state === 'dismissed' || row.state === 'discussed',
            onClick: () => void run(`dismiss ${row.id}`),
          },
          'Dismiss',
        ),
      ),
    )
  }
  function Count(props: PropsRuntime<'conversation.input.left'>) {
    const state = useStateOf(props.sessionId),
      count = state?.notices.filter((n) => n.state === 'new').length ?? 0
    return count
      ? h(
          'small',
          { className: 'dsh-session-tool-count', 'aria-label': `${count} Heads Up notices` },
          count,
        )
      : null
  }
  function Inline(props: PropsRuntime<'conversation.input.left'>) {
    const state = useStateOf(props.sessionId),
      rows = state?.notices.filter((n) => n.state === 'new') ?? []
    if (!rows.length) return null
    return h(
      'section',
      { className: 'dsh-heads-up-inline', 'aria-label': 'New Heads Up notices' },
      h(
        'style',
        null,
        '.dsh-heads-up-inline{font-size:12px;padding:6px 12px;margin:4px 0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;color:var(--dsw-alias-label-primary);}.dsh-heads-up-inline summary{cursor:pointer;}.dsh-heads-up-inline p{margin:6px 0;overflow-wrap:anywhere;}',
      ),
      h(
        'details',
        null,
        h('summary', null, `Heads up · ${rows.length} new · ${rows.at(-1)!.title}`),
        ...rows
          .slice(-3)
          .reverse()
          .map((n) => h('p', { key: n.id }, n.title)),
        h(
          'p',
          null,
          'Open Session tools > Heads Up to inspect sources, acknowledge, dismiss or discuss.',
        ),
      ),
    )
  }
  registerConversationPanel(ctx, {
    id: 'heads-up',
    label: 'Heads Up',
    order: 18,
    component: Panel,
    badge: Count,
  })
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      { name: 'conversation.input.dock', id: 'heads-up-notices', order: 25 },
      Inline,
    ),
  )
}
