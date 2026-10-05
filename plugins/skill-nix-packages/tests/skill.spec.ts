import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import { NixSkillProvider } from '../src/provider.ts'
import {
  expandWrapper,
  frontmatterOf,
  nixPackagesOf,
  nixWrapperInstruction,
  parseSkill,
  quoteCommand,
} from '../src/skill.ts'

const source = `---
name: fix-nix
description: searches with ripgrep
metadata:
  nix-packages: ripgrep, fd
---

Search the repository with rg before answering.
`

describe('frontmatter parsing', () => {
  it('extracts the block between the first two --- lines', () => {
    expect(frontmatterOf(source)).toContain('nix-packages: ripgrep, fd')
    expect(frontmatterOf('no frontmatter')).toBeUndefined()
    expect(frontmatterOf('---\nonly an opener')).toBeUndefined()
  })

  it('parses name, description, nested metadata, and body', () => {
    const parsed = parseSkill(source)
    expect(parsed.name).toBe('fix-nix')
    expect(parsed.description).toBe('searches with ripgrep')
    expect(parsed.metadata).toEqual({ 'nix-packages': 'ripgrep, fd' })
    expect(parsed.content).toBe('Search the repository with rg before answering.')
  })

  it('splits and dedupes package lists', () => {
    expect(nixPackagesOf(parseSkill(source))).toEqual(['ripgrep', 'fd'])
    expect(nixPackagesOf(parseSkill('---\nname: x\ndescription: y\n---\nbody'))).toEqual([])
  })
})

describe('wrapper templating', () => {
  it('quotes commands the POSIX way', () => {
    expect(quoteCommand('echo hi')).toBe(`'echo hi'`)
    expect(quoteCommand(`echo it's`)).toBe(`'echo it'\\''s'`)
  })

  it('expands both placeholders and appends missing command slots', () => {
    expect(expandWrapper('nix shell {packages} -c {command}', ['ripgrep', 'fd'], 'rg -n foo')).toBe(
      `nix shell nixpkgs#ripgrep nixpkgs#fd -c 'rg -n foo'`,
    )
    expect(expandWrapper('nix shell {packages}', ['fd'], 'fd -e lisp')).toBe(
      `nix shell nixpkgs#fd -c 'fd -e lisp'`,
    )
    expect(expandWrapper('nix develop -c {command}', ['ripgrep'], 'rg')).toBe(
      `nix develop -c nixpkgs#ripgrep 'rg'`,
    )
  })

  it('renders the model-facing instruction', () => {
    const text = nixWrapperInstruction(['ripgrep', 'fd'], 'nix shell {packages} -c {command}')
    expect(text).toContain('ripgrep, fd')
    expect(text).toContain('nixpkgs#ripgrep nixpkgs#fd')
  })
})

describe('provider', () => {
  it('lists bundles with metadata and appends the wrapper note on load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nix-skills-'))
    await mkdir(join(root, 'fix-nix'))
    await writeFile(join(root, 'fix-nix', 'SKILL.md'), source, 'utf8')
    const provider = new NixSkillProvider({
      roots: [root],
      rank: 350,
      wrapperTemplate: 'nix shell {packages} -c {command}',
    })
    const candidates = await provider.list({})
    expect(candidates.map((candidate) => candidate.name)).toEqual(['fix-nix'])
    const first = candidates[0]
    expect(first).toBeDefined()
    expect(first?.metadata).toEqual({ 'nix-packages': 'ripgrep, fd' })
    const definition = await provider.get(first!)
    expect(definition?.content).toContain('Search the repository with rg')
    expect(definition?.content).toContain('This skill declares Nix packages')
    expect(definition?.content).toContain(`nixpkgs#ripgrep nixpkgs#fd -c 'COMMAND'`)
  })

  it('skips unreadable roots and nameless bundles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nix-skills-'))
    await mkdir(join(root, 'not-a-skill'))
    await writeFile(join(root, 'not-a-skill', 'SKILL.md'), 'no frontmatter', 'utf8')
    const provider = new NixSkillProvider({
      roots: [root, join(root, 'absent')],
      rank: 350,
      wrapperTemplate: 'nix shell {packages} -c {command}',
    })
    expect(await provider.list({})).toEqual([])
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

describe('plugin binding', () => {
  it('registers the provider and the command against real services', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    const root = await mkdtemp(join(tmpdir(), 'nix-skills-'))
    await mkdir(join(root, 'fix-nix'))
    await writeFile(join(root, 'fix-nix', 'SKILL.md'), source, 'utf8')
    const handle = await ctx.plugin(plugin, { roots: [root] })
    const agent = stubAgent(ctx, 'nix-skills-1')
    await ctx.agents.register(agent)
    const settled = await ctx.commands.execute(
      agent,
      '/nix-skills',
      [],
      new AbortController().signal,
    )
    expect(settled?.result).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('nix shell {packages} -c {command}'),
    })
    const definitions = await ctx.skills.list()
    expect(definitions.some((skill) => skill.name === 'fix-nix')).toBe(true)
    const loaded = await ctx.skills.get('fix-nix')
    expect(loaded?.content).toContain('This skill declares Nix packages')
    await handle.dispose()
  })
})
