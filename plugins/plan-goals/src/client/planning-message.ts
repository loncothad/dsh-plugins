declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'goal-planning': { kind: 'goal-planning'; form: 'notice'; summary: string; objective: string }
  }
}

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/src/client/contract/chat-nodes.ts'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { openConversationPanel } from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h } from 'react'

interface PlanningCard {
  objective: string
  summary: string
  seq: number
}
declare module '@deepseek-ai/dsh-client-ui-chat/src/client/contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    'plugin-goal-planning': PlanningCard
  }
}
export function registerPlanningMessages(ctx: Context) {
  const definition: ConversationNodeDefinition<PlanningCard> = {
    kind: 'plugin-goal-planning',
    target: 'chat',
    match: (event) =>
      event.type === 'user/message' &&
      (event.data.source as { kind: string }).kind === 'goal-planning'
        ? { id: String(event.data.id), role: 'start' }
        : null,
    start: (_context, match) => {
      const event = match.event
      if (event.type !== 'user/message') throw Error('Expected planning request')
      const source = event.data.source as { objective: string; summary: string }
      return { objective: source.objective, summary: source.summary, seq: event.seq }
    },
    update: (context) => context.state,
    buildViewNode: (context) =>
      context.state
        ? {
            key: context.key,
            id: context.id,
            kind: 'plugin-goal-planning',
            target: 'chat',
            anchorSeq: context.state.seq,
            location: { kind: 'session' },
            visibility: 'visible',
            data: context.state,
          }
        : null,
  }
  ctx.inject(['uiConversation'], (scope) => scope.uiConversation.events.register(definition))
  function Planning(props: PropsRuntime<'conversation.chat.node', 'plugin-goal-planning'>) {
    return h(
      'section',
      {
        'aria-label': 'Goal planning request',
        style: {
          padding: '12px 16px',
          margin: '8px 0',
          border: '0.5px solid var(--dsw-alias-border-l2)',
          borderRadius: 'var(--dsw-radius-md)',
          fontSize: 12,
        },
      },
      h('strong', null, props.node.data.summary),
      h('p', { style: { margin: '6px 0', overflowWrap: 'anywhere' } }, props.node.data.objective),
      h(
        'small',
        null,
        'Planning instructions sent to the model. Your approval is required before work starts.',
      ),
      h(
        'div',
        { style: { marginTop: 8 } },
        h(
          Button,
          {
            size: 'sm',
            variant: 'outline',
            onClick: () => openConversationPanel(ctx, props.sessionId, 'plan-goals'),
          },
          'Open goals',
        ),
      ),
    )
  }
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register({ name: 'conversation.chat.node', key: 'plugin-goal-planning' }, Planning),
  )
}
