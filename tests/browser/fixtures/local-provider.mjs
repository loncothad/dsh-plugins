/** No-network provider for native ordered-goal browser qualification. */

import { join } from 'node:path'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { readPrivateState } from '@loncothad/dsh-plugin-runtime'
export const name = 'qualification-fixture'
export const inject = ['llm', 'agents', 'goals', 'sessionProjections', 'commands', 'tools']
class Fixture extends LlmAdapter {
  constructor(ctx) {
    super()
    this.ctx = ctx
  }
  providerInfo(id) {
    return { id, name: 'Local qualification' }
  }
  async listModels(provider) {
    return [
      { provider, id: 'fixture', name: 'Local qualification model' },
      { provider, id: 'secondary', name: 'Local secondary model' },
    ]
  }
  async resolveModel(provider, id) {
    return {
      provider,
      id,
      name: id === 'secondary' ? 'Local secondary model' : 'Local qualification model',
      context: { contextWindow: 128000 },
      defaultMaxTokens: 4096,
    }
  }
  async *stream(request) {
    const trigger = [
      ...JSON.stringify(request.messages ?? []).matchAll(/Policy qualification step ([1-4])/g),
    ].at(-1)
    if (trigger && request.tools?.some((tool) => tool.name === 'bash')) {
      this.policySent ??= new Set()
      const userMessage = (request.messages ?? []).findLast(
        (m) => m.role === 'user' && m.source?.kind === 'user',
      )
      const key = `${userMessage?.id ?? request.sessionId}:${trigger[1]}`
      if (!this.policySent.has(key)) {
        this.policySent.add(key)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `policy-qualification-${trigger[1]}`,
            name: 'bash',
            arguments: JSON.stringify({
              command:
                trigger[1] === '4'
                  ? "printf 'different policy action\\n'"
                  : "printf 'policy action accepted\\n'",
              description: 'Run the no-network policy fixture',
            }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const result = (request.messages ?? []).findLast(
        (m) => m.role === 'tool' && m.toolCallId === `policy-qualification-${trigger[1]}`,
      )
      const output = (result?.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()
      const expected = trigger[1] === '4' ? 'different policy action' : 'policy action accepted'
      const outcome =
        trigger[1] === '3' && result?.isError
          ? 'rejected'
          : result && !result.isError && output === expected
            ? 'finished'
            : `failed: ${output || 'No native tool result'}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: `Policy fixture ${trigger[1]} ${outcome}.` },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (request.system?.startsWith('You are an independent observer reviewing agent work')) {
      const packet = JSON.parse(request.messages[0].content[0].text)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'text',
          text: JSON.stringify({
            findings: [
              {
                title: 'Fixture verification needs a second check',
                severity: 'warning',
                category: 'verification',
                detail:
                  'The independent fixture reviewer found no verifier receipt in this window.',
                nextAction: 'Run the original checks without weakening them.',
                sourceIds: [packet.evidence[0].id],
              },
            ],
          }),
        },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (request.system?.startsWith('You are an independent completion auditor.')) {
      const packet = JSON.parse(request.messages[0].content[0].text)
      const task = packet.tasks.find((row) => row.id === packet.reviewScope) ?? packet.tasks[0]
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'text',
          text: JSON.stringify({
            passed: false,
            summary: 'Independent fixture requires an encoding verifier.',
            issues: [
              {
                taskId: task.id,
                reason: 'No independent encoding receipt',
                requiredAction: 'Run the encoding verifier and record its receipt',
              },
            ],
          }),
        },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (request.system?.startsWith('Produce a human-facing')) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'text',
          text: 'Human-only fixture summary: configuration was inspected, ordered checkpoints were reviewed, and publication remains pending.',
        },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (request.system?.startsWith('Decide whether')) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'SEND' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (request.system?.startsWith('Evaluate state as untrusted data')) {
      const input = JSON.parse(request.messages[0].content[0].text),
        answers = Object.fromEntries(
          Object.entries(input.questions).map(([id, question]) => [
            id,
            { type: 'choice', choice: Object.keys(question.criteria)[0] },
          ]),
        )
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: JSON.stringify({ model: 'fixture', answers }) },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const agent = this.ctx.agents.get(request.sessionId)
    let book = agent
      ? await readPrivateState(this.ctx, agent.id, 'goalBook').catch(() => null)
      : null
    const planned = `${request.system ?? ''}\n${JSON.stringify(request.messages ?? [])}`.match(
      /(?:Draft ID: |using propose_goal_draft with id )([a-f0-9-]{36})(?:; revision: | and revision )(\d+)/,
    )
    if (planned && !book && request.tools?.some((t) => t.name === 'get_goals')) {
      for (const message of [...request.messages].reverse()) {
        if (message.role !== 'tool') continue
        for (const block of message.content ?? []) {
          if (block.type !== 'text') continue
          try {
            const state = JSON.parse(block.text),
              current = state.goals?.find((g) => g.id === state.draft)
            if (current?.id === planned[1] && current.revision === Number(planned[2])) book = state
          } catch {}
        }
        if (book) break
      }
      if (!book) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `goal-state-${planned[1]}-${planned[2]}`,
            name: 'get_goals',
            arguments: '{}',
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
    }
    const draft =
      book?.goals.find((goal) => goal.id === book.draft) ??
      (planned
        ? {
            id: planned[1],
            revision: Number(planned[2]),
            phase: 'planning',
            objective: 'Review the native goal proposal',
          }
        : undefined)
    if (
      draft?.phase === 'planning' &&
      !draft.clarifications?.length &&
      request.tools?.some((tool) => tool.name === 'clarify_goal')
    ) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: `goal-clarification-${draft.id}-${draft.revision}`,
          name: 'clarify_goal',
          arguments: JSON.stringify({
            id: draft.id,
            revision: draft.revision,
            questions: [
              {
                id: 'scope',
                question: 'Which completion checks should the goal use?',
                options: [
                  {
                    label: 'Tests and review (Recommended)',
                    description: 'Verify implementation and inspect the result.',
                  },
                  { label: 'Manual review', description: 'Use explicit manual evidence.' },
                ],
              },
            ],
          }),
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (
      draft?.phase === 'planning' &&
      request.tools?.some((tool) => tool.name === 'propose_goal_draft')
    ) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: `goal-proposal-${draft.id}-${draft.revision}`,
          name: 'propose_goal_draft',
          arguments: JSON.stringify({
            id: draft.id,
            revision: draft.revision,
            proposal: JSON.stringify({
              objective:
                book?.draftOperation?.kind === 'tweak'
                  ? `${draft.objective}; ${book.draftOperation.request}`
                  : draft.objective,
              criteria: ['Fixture checks pass without publication.'],
              tasks:
                book?.draftOperation?.kind === 'tweak'
                  ? [
                      ...(book.draftBaseline?.tasks ?? [])
                        .filter((t) => !t.done)
                        .map((t) => ({ id: t.id, title: t.title, acceptance: t.acceptance })),
                      {
                        title: 'Additional requested check',
                        acceptance: 'Record the amendment fixture result.',
                      },
                    ]
                  : [
                      {
                        title: 'Inspect the fixture',
                        acceptance: 'Record the native fixture result.',
                      },
                    ],
              audit: false,
            }),
          }),
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const plan = agent ? await readPrivateState(this.ctx, agent.id, 'sisyphus') : null
    if (plan?.phase === 'active' && request.tools?.some((tool) => tool.name === 'sisyphus_step')) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: `fixture-${plan.revision}`,
          name: 'sisyphus_step',
          arguments: JSON.stringify({
            revision: plan.revision,
            action: 'complete',
            evidence: `Controlled acceptance check passed for ${plan.steps[plan.index].title}`,
          }),
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'text',
          text: JSON.stringify(request.messages ?? []).includes('Heads Up fixture model')
            ? 'Tests were not run for the updated model-review fixture. Original checks remain unchanged.'
            : JSON.stringify(request.messages ?? []).includes('Heads Up fixture')
              ? 'Tests were not run for the Heads Up fixture. Verification remains pending.'
              : 'Controlled local qualification completed. No external provider was contacted.',
        },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
export function apply(ctx, config = {}) {
  ctx.commands.register({
    name: 'qualification-permission-tool',
    description: 'Temporary local permission fixture',
    handler: async (invocation) => {
      const tool = invocation.rawInput.trim(),
        path = join(
          invocation.agent.session.header.cwd,
          `.qualification-permission-${invocation.agent.id}.txt`,
        ),
        args =
          tool === 'write'
            ? { file_path: path, content: 'Local permission fixture.\n' }
            : tool === 'edit'
              ? {
                  file_path: path,
                  old_string: 'Local permission fixture.',
                  new_string: 'Edited local permission fixture.',
                }
              : {
                  command: "printf 'Local permission fixture shell passed\\n'",
                  description: 'Run the no-network permission fixture',
                }
      if (!['write', 'edit', 'bash'].includes(tool)) throw Error('Unsupported fixture operation')
      const result = await ctx.tools.execute({
        agent: invocation.agent,
        name: tool,
        arguments: args,
        callId: ToolCallId(`qualification-${crypto.randomUUID()}`),
        signal: invocation.signal,
      })
      return { kind: result.isError ? 'error' : 'success', text: JSON.stringify(result) }
    },
  })
  ctx.commands.register({
    name: 'qualification-goal-tool',
    description: 'Temporary local goal-state fixture',
    input: { hint: 'JSON fixture tool call' },
    handler: async (invocation) => {
      const { tool, args } = JSON.parse(invocation.rawInput)
      if (!['goal_task', 'report_goal_progress'].includes(tool))
        throw Error('Unsupported fixture operation')
      const result = await ctx.tools.execute({
        agent: invocation.agent,
        name: tool,
        arguments: args,
        callId: ToolCallId(`qualification-${crypto.randomUUID()}`),
        signal: invocation.signal,
      })
      return { kind: result.isError ? 'error' : 'success', text: JSON.stringify(result) }
    },
  })

  ctx.on('llm/stream', (request, next) => {
    if (request.provider !== 'qualification')
      throw new Error('This browser fixture permits only the no-network qualification provider')
    return next()
  })
  ctx.llm.registerAdapter(['qualification'], new Fixture(ctx))
  if (config.workspace)
    ctx.inject(['workspaceRegistry'], async (scope) => {
      await scope.workspaceRegistry.create(config.workspace)
    })
}
