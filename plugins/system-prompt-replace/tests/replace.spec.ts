import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import { resolvePrompt } from '../src/prompt.ts'

describe('prompt resolution domain', () => {
  it('takes exactly one source', () => {
    expect(resolvePrompt({ prompt: 'be brief.' })).toMatchObject({
      text: 'be brief.',
      source: 'config',
    })
    expect(resolvePrompt({ file: 'PROMPT.md' }, { read: () => 'file body' })).toMatchObject({
      text: 'file body',
      source: 'PROMPT.md',
    })
    expect(() => resolvePrompt({ prompt: 'a', file: 'b' })).toThrow('not both')
    expect(() => resolvePrompt({})).toThrow('no replacement prompt')
    expect(() =>
      resolvePrompt(
        { file: 'gone.md' },
        {
          read: () => {
            throw new Error('ENOENT')
          },
        },
      ),
    ).toThrow('cannot read the prompt file gone.md')
    expect(() => resolvePrompt({ file: 'empty.md' }, { read: () => '  \n' })).toThrow('is empty')
  })
})

describe('replacement through the real system-prompt seam', () => {
  it('becomes the sole section, dropping the harness prompt entirely', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(CommandRuntime)
    plugin.apply(
      ctx,
      { prompt: 'You are a concise ops agent.' },
      {
        io: {
          read: () => {
            throw new Error('unused')
          },
        },
      },
    )
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections).toEqual([
      { name: 'system-prompt-replace:complete', text: 'You are a concise ops agent.' },
    ])
    expect(renderPrompt(assembly)).toBe('You are a concise ops agent.')
    // The built-in identity section is gone.
    expect(assembly.sections.some((section) => section.name === 'harness:identity')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('reads the prompt file through the injected io', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(CommandRuntime)
    plugin.apply(
      ctx,
      { file: 'SUPERPROMPT.md' },
      {
        io: { read: () => 'Prompt from file.' },
      },
    )
    const assembly = await ctx.systemPrompt.assemble()
    expect(renderPrompt(assembly)).toBe('Prompt from file.')
    await ctx.fiber.dispose()
  })

  it('interpolates registered variables unless disabled', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(CommandRuntime)
    ctx.systemPrompt.variable('project', () => 'dsh-plugins')
    plugin.apply(
      ctx,
      { prompt: 'You work on {{project}}.' },
      {
        io: {
          read: () => {
            throw new Error('unused')
          },
        },
      },
    )
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe('You work on dsh-plugins.')
    await ctx.fiber.dispose()

    const literal = new Context()
    await literal.plugin(SystemPrompt)
    await literal.plugin(CommandRuntime)
    plugin.apply(
      literal,
      { prompt: 'Literal {{project}}.', interpolate: false },
      {
        io: {
          read: () => {
            throw new Error('unused')
          },
        },
      },
    )
    expect(renderPrompt(await literal.systemPrompt.assemble())).toBe('Literal {{project}}.')
    await literal.fiber.dispose()
  })

  it('suppresses runtime context when configured', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(CommandRuntime)
    ctx.systemPrompt.context({
      name: 'test:sandbox',
      order: ctx.systemPrompt.getContextOrder('SANDBOX_POLICY'),
      text: 'sandbox policy snapshot',
    })
    plugin.apply(
      ctx,
      { prompt: 'replacement', suppressRuntimeContext: true },
      {
        io: {
          read: () => {
            throw new Error('unused')
          },
        },
      },
    )
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.contexts).toEqual([])
    await ctx.fiber.dispose()
  })

  it('reports the active replacement through /system-prompt', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    plugin.apply(
      ctx,
      { file: 'SUPERPROMPT.md' },
      {
        io: { read: () => 'The replacement body.' },
      },
    )
    const session = ctx.sessions.create(SessionId(`sp-${Math.random()}`))
    let status: AgentStatus = 'idle'
    const agent: Agent = {
      id: session.id,
      options: {},
      session,
      inbox: unsupportedInbox(),
      ctx: new Context(),
      get status() {
        return status
      },
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject: () => {},
      cancel() {
        status = 'idle'
      },
      runMaintenance: (task) => task(new AbortController().signal),
      whenIdle() {
        return Promise.resolve()
      },
    }
    await ctx.agents.register(agent)
    const settled = await ctx.commands.execute(
      agent,
      '/system-prompt',
      [],
      new AbortController().signal,
    )
    expect(settled?.result).toMatchObject({
      kind: 'success',
      text: expect.stringMatching(/SUPERPROMPT\.md, 21 chars[\s\S]*The replacement body\./),
    })
    await ctx.fiber.dispose()
  })
})
