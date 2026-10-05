import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { buildImageBody, extensionOf, extractImageResult } from '../src/image.ts'
import { imageToolOptions, registerCodexImage, registerCodexModelCommands } from '../src/index.ts'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUg=='

function imageResponse() {
  return new Response(
    JSON.stringify({
      data: [{ b64_json: PNG_BASE64 }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('image domain', () => {
  it('projects the current native Images generation body', () => {
    expect(
      buildImageBody({ prompt: 'a lighthouse', size: '1024x1536', quality: 'low' }, 'gpt-image-2'),
    ).toEqual({
      model: 'gpt-image-2',
      prompt: 'a lighthouse',
      size: '1024x1536',
      quality: 'low',
      n: 1,
    })
  })
  it('extracts inline native data and rejects obsolete Responses shapes', () => {
    expect(extractImageResult({ data: [{ b64_json: PNG_BASE64 }] })).toEqual({ base64: PNG_BASE64 })
    expect(() => extractImageResult({ data: [] })).toThrow('no generated image')
    expect(() => extractImageResult({ data: [{ b64_json: 'not an image' }] })).toThrow('encoding')
  })
  it('uses actual image bytes for file extensions', () => {
    expect(extensionOf({ base64: PNG_BASE64 })).toBe('.png')
    expect(() => extensionOf({ base64: 'eA==' })).toThrow('Unsupported')
  })
})

function stubAgent(ctx: Context): Agent {
  const session = ctx.sessions.create(SessionId(`codex-image-${Math.random()}`))
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

describe('registered commands', () => {
  it('writes the generated image and reports the path', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'codex-image-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SkillRegistry)

    const fetch = vi.fn(async () => imageResponse())
    const ioWrites: string[] = []
    const options = {
      endpoint: 'https://chatgpt.test/backend-api/codex/responses',
      model: 'gpt-image-2',
      outDir,
      tokens: async () => ({ accessToken: 'sub', accountId: 'acct' }),
      fetch: fetch as unknown as typeof fetch,
      io: {
        mkdir: async () => {},
        writeFile: async (path: string, data: Buffer) => {
          ioWrites.push(path)
          const { writeFile } = await import('node:fs/promises')
          await writeFile(path, data)
        },
      },
    }
    registerCodexImage(ctx, options)
    // The /codex-image command is model-behavior UX: it mounts through the
    // contextual group (available here — no selection service mounted).
    registerCodexModelCommands(ctx, { image: imageToolOptions(options) })

    const agent = stubAgent(ctx)
    await ctx.agents.register(agent)
    const settled = await ctx.commands.execute(
      agent,
      '/codex-image a lighthouse at dusk',
      [],
      new AbortController().signal,
    )
    expect(settled?.result).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('Image written to'),
    })
    const written = (settled!.result as { text: string }).text.match(/Image written to (\S+)/)![1]!
    const bytes = await readFile(written)
    expect(bytes.length).toBeGreaterThan(0)
    expect(ioWrites).toEqual([written])

    const call = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0]).toBe('https://chatgpt.test/backend-api/codex/responses')
    expect(call[1].headers).toMatchObject({
      authorization: 'Bearer sub',
      'chatgpt-account-id': 'acct',
      originator: 'pi',
      'user-agent': expect.stringMatching(/^pi \(.*; .*\)$/),
    })
    const body = JSON.parse(call[1].body as string)
    expect(body).toMatchObject({ model: 'gpt-image-2', prompt: expect.any(String), n: 1 })
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('stream')
  })

  it('errors with the login hint when no account is signed in', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SkillRegistry)

    const fetch = vi.fn()
    const options = {
      endpoint: 'https://chatgpt.test/backend-api/codex/responses',
      model: 'gpt-image-2',
      outDir: join(tmpdir(), 'codex-image-none'),
      tokens: async () => undefined,
      fetch: fetch as unknown as typeof fetch,
    }
    registerCodexImage(ctx, options)
    registerCodexModelCommands(ctx, { image: imageToolOptions(options) })

    const agent = stubAgent(ctx)
    await ctx.agents.register(agent)
    const settled = await ctx.commands.execute(
      agent,
      '/codex-image x',
      [],
      new AbortController().signal,
    )
    expect(settled?.result).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('Plugins → ChatGPT Codex → Subscription login'),
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
