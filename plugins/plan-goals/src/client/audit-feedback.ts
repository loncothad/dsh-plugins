import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/src/client/contract/chat-nodes.ts'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement as h } from 'react'

declare module '@deepseek-ai/dsh-client-ui-chat/src/client/contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    'plugin-goal-audit': { text: string; seq: number }
  }
}
export function registerAuditFeedback(ctx: Context) {
  const definition: ConversationNodeDefinition<{ text: string; seq: number }> = {
    kind: 'plugin-goal-audit',
    target: 'chat',
    match: (event) =>
      event.type === 'user/message' && (event.data.source as { kind: string }).kind === 'goal-audit'
        ? { id: String(event.data.id), role: 'start' }
        : null,
    start: (_context, match) => {
      const event = match.event
      if (event.type !== 'user/message') throw Error('Expected audit feedback')
      return {
        seq: event.seq,
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
            kind: 'plugin-goal-audit',
            target: 'chat',
            anchorSeq: context.state.seq,
            location: { kind: 'session' },
            visibility: 'visible',
            data: context.state,
          }
        : null,
  }
  ctx.inject(['uiConversation'], (scope) => scope.uiConversation.events.register(definition))
  function Feedback(props: PropsRuntime<'conversation.chat.node', 'plugin-goal-audit'>) {
    return h(
      'section',
      {
        'aria-label': 'Independent goal audit',
        style: {
          padding: 12,
          margin: '8px 0',
          border: '0.5px solid var(--dsw-alias-border-l2)',
          borderRadius: 10,
          fontSize: 12,
        },
      },
      h('strong', null, 'Independent audit requires changes'),
      h(
        'pre',
        { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
        props.node.data.text,
      ),
    )
  }
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register({ name: 'conversation.chat.node', key: 'plugin-goal-audit' }, Feedback),
  )
}
