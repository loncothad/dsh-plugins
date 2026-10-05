import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { choiceInput, decisionRegistry } from '../src/index.ts'

it('owns providers through disposal and fences replies from replaced generations', async () => {
  const scope = new Context(),
    registry = decisionRegistry(scope)
  let finish: () => void = () => {}
  registry.register(scope, {
    id: 'fixture',
    models: ['actual'],
    defaultModel: 'actual',
    images: false,
    evaluate: async () => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return {
        model: 'actual',
        answers: { decision: { type: 'choice', choice: 'a' } },
        status: 'unverified',
      }
    },
  })
  const pending = registry.evaluate(
    'fixture',
    'default',
    choiceInput({ question: 'Pick', choices: ['a', 'b'] }),
    AbortSignal.timeout(5000),
  )
  await scope.fiber.dispose()
  finish()
  await expect(pending).rejects.toThrow('changed')
  expect(registry.list()).toEqual([])
})
