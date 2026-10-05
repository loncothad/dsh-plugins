import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'
import { registerAgentsSwitch } from '../src/index.ts'
import {
  clearMapping,
  fileFor,
  parseMapping,
  serializeMapping,
  setMapping,
} from '../src/mapping.ts'

describe('mapping domain', () => {
  it('parses and serializes the mapping table', () => {
    expect(parseMapping('')).toEqual([])
    expect(parseMapping(undefined)).toEqual([])
    expect(parseMapping('a/b=X.md ; broken ; c = Y.md')).toEqual([
      { designator: 'a/b', file: 'X.md' },
      { designator: 'c', file: 'Y.md' },
    ])
    expect(serializeMapping([{ designator: 'a/b', file: 'X.md' }])).toBe('a/b=X.md')
  })

  it('sets and clears exact designators', () => {
    const table = setMapping([], 'x/y', 'X.md')
    expect(setMapping(table, 'X/Y', 'Z.md')).toEqual([{ designator: 'X/Y', file: 'Z.md' }])
    expect(clearMapping(table, 'x/y')).toEqual({ entries: [], removed: true })
    expect(clearMapping(table, 'q/r')).toEqual({ entries: table, removed: false })
  })

  it('resolves exact before suffix before default', () => {
    const table = [
      { designator: 'provider/gpt-x', file: 'EXACT.md' },
      { designator: 'x', file: 'SUFFIX.md' },
    ]
    expect(fileFor(table, 'provider/gpt-x', 'gpt-x', 'AGENTS.md')).toBe('EXACT.md')
    expect(
      fileFor(
        table.filter((entry) => entry.designator !== 'provider/gpt-x'),
        'provider/gpt-x',
        'gpt-x',
        'AGENTS.md',
      ),
    ).toBe('SUFFIX.md')
    expect(fileFor([], 'anything', 'gpt-x', 'AGENTS.md')).toBe('AGENTS.md')
  })
})

/** Build a live idle agent over a store-owned session, as an app's spine does. */
function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
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
  return agent
}

async function harness(mapValue = '', modelValue = 'glm-5.3') {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  new AgentDefaultModel(ctx, {
    provider: { get: () => 'zai' },
    model: { get: () => modelValue },
    reasoningEffort: { get: () => undefined },
  } as never)
  registerAgentsSwitch(ctx, {
    map: () => mapValue,
    defaultFile: () => 'AGENTS.md',
    setMap: (next) => {
      mapValue = next
    },
  })
  const agent = stubAgent(ctx, `agents-switch-${Math.random()}`)
  await ctx.agents.register(agent)
  return {
    ctx,
    map: () => mapValue,
    async run(raw: string) {
      const settled = await ctx.commands.execute(
        agent,
        `/agents-file${raw}`,
        [],
        new AbortController().signal,
      )
      if (settled === undefined) throw new Error('agents-file not registered')
      return settled.result
    },
  }
}

describe('section and command', () => {
  it('contributes nothing without a mapping and lists the table', async () => {
    const h = await harness()
    const assembly = await h.ctx.systemPrompt.assemble({})
    expect(
      assembly.sections.find((section) => section.name === 'agents-switch:superprompt')?.text ?? '',
    ).toBe('')
    expect(await h.run('')).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('Superprompt file for zai/glm-5.3: AGENTS.md'),
    })
    expect(await h.run(' status')).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('Superprompt file for zai/glm-5.3: AGENTS.md'),
    })
  })

  it('sets a mapping, injects the mapped file, and clears it', async () => {
    const file = await mkdtemp(join(tmpdir(), 'agents-switch-')).then((dir) => join(dir, 'TEAM.md'))
    await writeFile(file, 'Shared superprompt body.', 'utf8')
    const h = await harness()
    expect(await h.run(` ${file.replaceAll('\\', '/')}`)).toMatchObject({
      kind: 'success',
      text: expect.stringContaining(`set to ${file.replaceAll('\\', '/')}`),
    })
    // The command's refresh reads the mapped file asynchronously; let the
    // I/O settle before assembly.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const assembly = await h.ctx.systemPrompt.assemble({})
    const section =
      assembly.sections.find((entry) => entry.name === 'agents-switch:superprompt')?.text ?? ''
    expect(section).toContain('Shared superprompt body.')
    expect(section).toContain(`From ${file.replaceAll('\\', '/')}`)
    expect(await h.run(' clear')).toMatchObject({ kind: 'success' })
    expect(await h.run(' clear')).toMatchObject({ kind: 'error' })
  })
})
