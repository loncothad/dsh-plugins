import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createVolatile } from '@deepseek-ai/cosmokit'
import { redactSecrets } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { expect, it, vi } from 'vitest'
import { configEntry, editableConfig, managedApply } from '../src/index.ts'

it('replaces Loader-managed capabilities after configuration changes and disposes every generation', async () => {
  const ctx = new Context()
  const starts: string[] = []
  const stops: string[] = []
  const schema = z.object({
    endpoint: z.string(),
    key: z.string().role('secret'),
    speed: z.string().volatile(),
  })
  const plugin = {
    name: 'probe',
    Config: editableConfig(schema),
    apply: managedApply(schema, (child, config: { endpoint: string; speed: { get(): string } }) => {
      expect(configEntry(child)?.options.name).toBe('cordis:probe')
      starts.push(`${config.endpoint}:${config.speed.get()}`)
      child.effect(() => () => {
        stops.push(config.endpoint)
      })
    }),
  }
  await ctx.plugin(Loader)
  ctx.loader.builtins.probe = plugin
  const id = await ctx.loader.create({
    name: 'cordis:probe',
    config: { endpoint: 'first', speed: 'slow' },
  })
  const entry = ctx.loader.resolve(id)
  await entry.fiber!.await()
  expect(starts).toEqual(['first:slow'])
  await entry.update({ config: { endpoint: 'second', speed: 'fast' } })
  ctx.emit('app-boot/config-reload')
  await vi.waitFor(() => expect(starts).toEqual(['first:slow', 'second:fast']))
  expect(stops).toEqual(['first'])
  await ctx.fiber.dispose()
  expect(stops).toEqual(['first', 'second'])
})

it('preserves secret metadata while exposing the complete schema', () => {
  const schema = editableConfig(z.object({ key: z.string().role('secret'), endpoint: z.string() }))
  expect(schema.meta.volatile).toBe(true)
  const result = redactSecrets(schema as never, { key: 'private', endpoint: 'public' })
  expect(result.value).toEqual({ endpoint: 'public' })
  expect(result.secrets).toEqual([{ path: ['key'], set: true }])
})

it('does not report managed activation success before asynchronous capability initialization settles', async () => {
  const ctx = new Context()
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const schema = z.object({ endpoint: z.string() })
  let complete = false
  try {
    const fiber = ctx.plugin(
      {
        Config: editableConfig(schema),
        apply: managedApply(schema, async () => {
          started.resolve()
          await gate.promise
          complete = true
        }),
      },
      { endpoint: 'fixture' },
    )
    await started.promise
    let activated = false
    const wait = fiber.await().then(() => {
      activated = true
    })
    await Promise.resolve()
    expect(activated).toBe(false)
    gate.resolve()
    await wait
    expect(complete).toBe(true)
  } finally {
    gate.resolve()
    await ctx.fiber.dispose()
  }
})

it('validates nonempty dictionaries from immutable native configuration snapshots without modifying them', async () => {
  const ctx = new Context(),
    snapshot = createVolatile({ routes: { model: 'azure' }, rows: [{ name: 'first' }] })
  const schema = z.object({
    routes: z.dict(z.string()),
    rows: z.array(z.object({ name: z.string() })),
  })
  let value: unknown
  try {
    await managedApply(schema, (_child, config) => {
      value = config
    })(ctx, snapshot)
    expect(value).toEqual({ routes: { model: 'azure' }, rows: [{ name: 'first' }] })
    expect(Object.isFrozen(snapshot.get().routes)).toBe(true)
  } finally {
    await ctx.fiber.dispose()
  }
})
