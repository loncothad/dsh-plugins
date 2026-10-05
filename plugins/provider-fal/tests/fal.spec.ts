import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MediaExecutionError } from '@loncothad/dsh-media-gen'
import { describe, expect, it } from 'vitest'
import { apply, buildFalBody, FalGenerator } from '../src/index.ts'

const registryItem = {
  endpoint_id: 'fal-ai/edit',
  metadata: {
    display_name: 'Edit',
    category: 'image-to-image',
    status: 'active',
    kind: 'inference',
  },
}

describe('generator wire', () => {
  it('maps inputs onto conventional body fields, options winning', () => {
    expect(
      buildFalBody({
        model: 'm',
        prompt: 'go',
        inputs: [{ kind: 'image', url: 'data:image/png;base64,QQ' }],
        options: { num_images: 2 },
      }),
    ).toEqual({ prompt: 'go', image_url: 'data:image/png;base64,QQ', num_images: 2 })
    expect(
      buildFalBody({
        model: 'm',
        prompt: 'go',
        inputs: [
          { kind: 'image', url: 'a.png' },
          { kind: 'image', url: 'b.png' },
          { kind: 'video', url: 'v.mp4' },
          { kind: 'audio', url: 'a.wav' },
        ],
        options: { image: 'override.png' },
      }),
    ).toEqual({
      prompt: 'go',
      image_urls: ['a.png', 'b.png'],
      video_url: 'v.mp4',
      audio_url: 'a.wav',
      image: 'override.png',
    })
  })

  it('authenticates with the Key scheme on sync runs', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const generator = new FalGenerator({
      apiKey: () => 'fal-key',
      fetch: (async (url, init) => {
        calls.push({ url: String(url), init })
        return new Response(JSON.stringify({ image_url: 'https://f.test/1.png' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
    })
    const result = await generator.generate({
      output: 'image',
      model: 'fal-ai/flux/schnell',
      prompt: 'a cat',
    })
    expect(calls[0]!.url).toBe('https://fal.run/fal-ai/flux/schnell')
    expect(new Headers(calls[0]!.init!.headers).get('authorization')).toBe('Key fal-key')
    expect(result.raw).toMatchObject({ image_url: 'https://f.test/1.png' })
  })

  it('submits to the queue for video and polls until COMPLETED', async () => {
    const seen: string[] = []
    let poll = 0
    const submitUrl = 'https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video'
    const generator = new FalGenerator({
      apiKey: () => 'fal-key',
      pollMs: 0,
      fetch: (async (url: RequestInfo | URL) => {
        const target = String(url)
        seen.push(target)
        if (target === submitUrl) {
          return new Response(
            JSON.stringify({
              request_id: 'r1',
              status_url: 'https://queue.fal.run/requests/r1/status',
              response_url: 'https://queue.fal.run/requests/r1',
            }),
            { status: 200 },
          )
        }
        if (target.endsWith('/status')) {
          poll++
          return new Response(JSON.stringify({ status: poll >= 2 ? 'COMPLETED' : 'IN_PROGRESS' }), {
            status: 200,
          })
        }
        return new Response(JSON.stringify({ video: { url: 'https://f.test/v.mp4' } }), {
          status: 200,
        })
      }) as typeof fetch,
    })
    const result = await generator.generate({
      output: 'video',
      model: 'fal-ai/kling-video/v3/pro/image-to-video',
      prompt: 'animate',
      inputs: [{ kind: 'image', url: 'https://f.test/src.png' }],
    })
    expect(seen[0]).toBe(submitUrl)
    expect(result.raw).toMatchObject({ video: { url: 'https://f.test/v.mp4' } })
    expect(seen.filter((url) => url.endsWith('/status'))).toHaveLength(2)
  })

  it('classifies auth, missing-model, and validation failures', async () => {
    const failing = (status: number, body?: unknown) =>
      new FalGenerator({
        apiKey: () => 'fal-key',
        fetch: (async () =>
          new Response(body === undefined ? 'no' : JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch,
      })
    await expect(
      failing(401).generate({ output: 'image', model: 'm', prompt: 'p' }),
    ).rejects.toMatchObject({ code: 'AUTH' })
    await expect(
      failing(404).generate({ output: 'image', model: 'm', prompt: 'p' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      failing(422, { detail: 'image_url required' }).generate({
        output: 'image',
        model: 'm',
        prompt: 'p',
      }),
    ).rejects.toMatchObject({ code: 'CLIENT' })
    await expect(
      new FalGenerator({ apiKey: () => undefined }).generate({
        output: 'image',
        model: 'm',
        prompt: 'p',
      }),
    ).rejects.toBeInstanceOf(MediaExecutionError)
  })
})

describe('plugin wiring', () => {
  it('registers fal surfaces over the provider catalog', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SkillRegistry)
    apply(
      ctx,
      { apiKey: 'fal-key' },
      {
        fetch: async () =>
          new Response(JSON.stringify({ models: [registryItem], has_more: false })),
      },
    )
    const session = ctx.sessions.create(SessionId(`fal-${Math.random()}`))
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
      '/fal-models',
      [],
      new AbortController().signal,
    )
    expect(settled?.result).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('text+image -> image'),
    })
    await ctx.fiber.dispose()
  })
})
