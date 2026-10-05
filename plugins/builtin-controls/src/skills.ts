import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { SkillCandidate } from '@deepseek-ai/dsh-skill'

/** Public provider precedence and invocation policy, without replacing registry methods. */
export async function maskSkills(ctx: Context, disabled: string[]): Promise<void> {
  const register = (scope: Context) =>
    scope.skills.registerProvider(() => ({
      name: 'builtin-controls-disabled',
      async list(options) {
        options.signal?.throwIfAborted()
        return disabled.map(
          (name): SkillCandidate => ({
            name,
            description:
              'Disabled for future invocation in this profile. Enable to discover its source.',
            source: 'operator-disabled',
            provider: 'builtin-controls-disabled',
            invocation: { modelInvocable: false, userInvocable: false },
            rank: -Number.MAX_VALUE,
            locator: name,
          }),
        )
      },
      async get(candidate, options) {
        options.signal?.throwIfAborted()
        return { ...candidate, content: '' }
      },
    }))
  if (!disabled.length) return
  register(ctx)
  const owned = new Map<object, Fiber>()
  const attach = async (agent: import('@deepseek-ai/dsh-agent').Agent) => {
    if (owned.has(agent) || !scopeOf(agent.ctx)) return
    const fiber = agent.ctx.plugin({ inject: ['skills'], apply: register })
    owned.set(agent, fiber)
    await fiber.await()
  }
  ctx.effect(
    () => async () => {
      await Promise.all([...owned.values()].map((fiber) => fiber.dispose()))
      owned.clear()
    },
    'builtin-controls: withdraw agent skill masks',
  )
  ctx.on('agent/created', async ({ agent }) => {
    await attach(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    owned.delete(agent)
  })
  for (const agent of ctx.agents.list()) await attach(agent)
}
