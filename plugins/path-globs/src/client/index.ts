import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/src/client/contract/chat-nodes.ts'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button, Input, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  configurationTheme,
  registerConfiguration,
  registerConversationPanel,
} from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h, useState } from 'react'
import type { Expansion } from '../engine.ts'

declare module '@deepseek-ai/dsh-client-ui-chat/src/client/contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    'plugin-path-globs': { summary: string; text: string; seq: number }
  }
}
export const inject = [
  'slots',
  'locale',
  'configForms',
  'settingsSchema',
  'remote',
  'remote.commands',
  'sessions',
]
export function apply(ctx: Context): void {
  const definition: ConversationNodeDefinition<{ summary: string; text: string; seq: number }> = {
    kind: 'plugin-path-globs',
    target: 'chat',
    match: (event) =>
      event.type === 'user/message' && (event.data.source as { kind: string }).kind === 'path-globs'
        ? { id: String(event.data.id), role: 'start' }
        : null,
    start: (_context, match) => {
      const event = match.event
      if (event.type !== 'user/message') throw Error('Expected glob context')
      const source = event.data.source as { summary?: string }
      return {
        seq: event.seq,
        summary: source.summary ?? 'Expanded file paths',
        text: event.data.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(''),
      }
    },
    update: (context) => context.state,
    buildViewNode: (context) =>
      context.state
        ? {
            key: context.key,
            id: context.id,
            kind: 'plugin-path-globs',
            target: 'chat',
            anchorSeq: context.state.seq,
            location: { kind: 'session' },
            visibility: 'visible',
            data: context.state,
          }
        : null,
  }
  ctx.inject(['uiConversation'], (scope) => scope.uiConversation.events.register(definition))
  function ExpandedFiles(props: PropsRuntime<'conversation.chat.node', 'plugin-path-globs'>) {
    return h(
      'section',
      {
        'aria-label': 'Glob expansion applied',
        style: { margin: '4px 0 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      },
      h(
        'details',
        { className: 'config-glob-disclosure' },
        h(
          'summary',
          { style: { cursor: 'pointer' } },
          '✦ Glob expanded · ',
          props.node.data.summary,
        ),
        h(
          'p',
          null,
          'File-name snapshot supplied with your request. Your original text is unchanged.',
        ),
        h(
          'pre',
          {
            style: {
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              maxHeight: 240,
              overflow: 'auto',
            },
          },
          props.node.data.text,
        ),
      ),
    )
  }
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register({ name: 'conversation.chat.node', key: 'plugin-path-globs' }, ExpandedFiles),
  )
  function Intro() {
    return h(
      'section',
      null,
      h('h3', null, 'File patterns in user messages'),
      h(
        'p',
        null,
        'Use src/**/*.ts, `*.md` or @tests/**. Your message stays unchanged. A collapsed context row shows matching file names; the model receives the full list. File contents are never read.',
      ),
      h(
        'p',
        null,
        '/glob preview PATTERN previews the same rules. Patterns are relative to the conversation workspace. Choose whether to honor project ignore files, toggle .gitignore and .ignore separately, or add other ignore-file names below. Rules start at the project root and optionally apply in child directories. Symlinks and Git metadata are skipped. Overflow fails explicitly.',
      ),
    )
  }
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-path-globs',
    rowId: 'path-globs',
    before: Intro,
    groups: [
      {
        title: 'Message expansion',
        description: 'Expand path patterns in your messages or preview them manually.',
        fields: ['automatic', 'commandEnabled', 'skipCodeBlocks'],
      },
      {
        title: 'Project and matching',
        description: 'Choose where paths resolve and which file names can match.',
        fields: ['rootMode', 'projectRoot', 'includeDotfiles', 'caseSensitive'],
      },
      {
        title: 'Ignore rules',
        description: 'Choose project ignore files, extra filenames and explicit exclusions.',
        fields: [
          'honorIgnoreFiles',
          'respectGitignore',
          'respectIgnore',
          'additionalIgnoreFiles',
          'nestedIgnoreFiles',
          'additionalExcludes',
        ],
      },
      {
        title: 'Scan limits',
        description: 'Stop visibly when a complete file list exceeds these bounds.',
        fields: [
          'maxPatterns',
          'maxMatches',
          'maxScanEntries',
          'maxDepth',
          'maxResultBytes',
          'maxIgnoreBytes',
          'timeoutMs',
        ],
      },
    ],
  })
  function Preview(props: PropsRuntime<'conversation.input.left'>) {
    const [pattern, setPattern] = useState(''),
      [result, setResult] = useState<Expansion>(),
      [error, setError] = useState(''),
      [busy, setBusy] = useState(false),
      [page, setPage] = useState(0)
    const scan = async () => {
      setBusy(true)
      setError('')
      try {
        const response = await ctx.remote.commands.execute(
          props.sessionId,
          `/glob preview ${pattern}`,
          [],
        )
        if (!response.ok) throw new Error(response.error.message)
        if (!response.value) throw new Error('Enable Path Globs on the host')
        if (response.value.result.kind === 'error') throw new Error(response.value.result.text)
        setResult(JSON.parse(response.value.result.text ?? '{}'))
        setPage(0)
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Preview failed')
      } finally {
        setBusy(false)
      }
    }
    return h(
      'section',
      { className: 'dsh-plugin-settings dsh-plugin-panel' },
      h('style', null, configurationTheme),
      h(
        'label',
        null,
        'File patterns',
        h(Input, {
          className: 'config-input',
          value: pattern,
          placeholder: 'src/**/*.ts tests/**/*.ts',
          disabled: busy,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setPattern(event.target.value),
        }),
      ),
      h(
        Button,
        {
          variant: 'primary',
          size: 'sm',
          disabled: busy || !pattern.trim(),
          onClick: () => {
            void scan()
          },
        },
        busy ? 'Expanding…' : 'Preview files',
      ),
      result
        ? h(
            'div',
            null,
            h('p', null, `${result.files.length} files · project ${result.root}`),
            h(
              'pre',
              null,
              result.files.slice(page * 100, (page + 1) * 100).join('\n') || 'No matching files.',
            ),
            h(
              'p',
              null,
              `Showing ${result.files.length ? page * 100 + 1 : 0}–${Math.min((page + 1) * 100, result.files.length)}. The full list is available to copy.`,
            ),
            h(
              Button,
              {
                size: 'sm',
                variant: 'outline',
                disabled: page === 0,
                onClick: () => setPage(page - 1),
              },
              'Previous',
            ),
            h(
              Button,
              {
                size: 'sm',
                variant: 'outline',
                disabled: (page + 1) * 100 >= result.files.length,
                onClick: () => setPage(page + 1),
              },
              'Next',
            ),
            h(
              Button,
              {
                size: 'sm',
                variant: 'outline',
                onClick: () => {
                  void writeClipboard(result.files.join('\n'))
                },
              },
              'Copy all paths',
            ),
          )
        : null,
      error ? h('p', { role: 'alert' }, error) : null,
    )
  }
  registerConversationPanel(ctx, {
    id: 'path-globs',
    label: 'Glob preview',
    order: 35,
    component: Preview,
  })
}
