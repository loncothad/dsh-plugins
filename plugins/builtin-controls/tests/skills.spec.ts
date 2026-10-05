import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry, { isModelInvocable, isUserInvocable } from '@deepseek-ai/dsh-skill'
import { expect, it } from 'vitest'
import { maskSkills } from '../src/skills.ts'

it('blocks both invocation paths in host and agent layers, then restores the original providers on disposal', async () => {
  const ctx = new Context(),
    key = {},
    standingKey = {},
    standing = createScope(ctx, standingKey),
    agentScope = createScope(ctx, key)
  try {
    await ctx.plugin(SkillRegistry)
    ctx.provide('agents', { list: () => [{ ctx: agentScope.ctx }] } as never)
    ctx.skills.register({
      name: 'example-skill',
      description: 'Original host skill',
      source: 'bundled',
      content: 'Original instructions',
    })
    bindScopeParent(key, standingKey)
    await standing.ctx.plugin({
      inject: ['skills'],
      apply(scope: Context) {
        scope.skills.register({
          name: 'example-skill',
          description: 'Original scoped skill',
          source: 'bundled',
          content: 'Scoped instructions',
        })
      },
    })
    expect((await ctx.skills.get('example-skill', { scope: key }))?.content).toBe(
      'Scoped instructions',
    )
    const masked = ctx.plugin({
      inject: ['agents', 'skills'],
      apply: (scope: Context) => maskSkills(scope, ['example-skill']),
    })
    await masked.await()
    for (const scope of [undefined, key]) {
      const skill = await ctx.skills.get('example-skill', { scope })
      expect(skill).toBeDefined()
      expect(isModelInvocable(skill!)).toBe(false)
      expect(isUserInvocable(skill!)).toBe(false)
      expect(skill!.content).toBe('')
    }
    await masked.dispose()
    expect((await ctx.skills.get('example-skill'))?.content).toBe('Original instructions')
    expect((await ctx.skills.get('example-skill', { scope: key }))?.content).toBe(
      'Scoped instructions',
    )
  } finally {
    await agentScope.dispose()
    await standing.dispose()
    await ctx.fiber.dispose()
  }
})
