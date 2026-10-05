import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import {
  buildContent,
  OpenRouterCatalog,
  OpenRouterMediaGenerator,
  parseModelsResponse,
} from '../src/index.ts'

// Trimmed from the live /api/v1/models response (grounded shapes).
const liveModels = {
  data: [
    {
      id: 'openai/gpt-6.1-sol-pro',
      name: 'OpenAI: GPT-6.1 Sol Pro',
      description: 'GPT-6.1 Sol Pro serves the same model with reasoning.mode set to pro.',
      context_length: 1_050_000,
      architecture: {
        input_modalities: ['file', 'image', 'text'],
        output_modalities: ['text'],
      },
      supported_parameters: ['reasoning', 'reasoning_effort', 'tools'],
      reasoning: {
        mandatory: true,
        supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'],
        default_effort: 'medium',
      },
      pricing: { prompt: '0.000002', completion: '0.00001' },
    },
    {
      id: '~typesafe/jev-latest',
      name: 'TypeSafe: Jev latest',
      alias_target: { name: 'TypeSafe: Jev', slug: 'typesafe/jev-1.13' },
    },
    {
      id: 'vendor/retired-model',
      name: 'Vendor: Retired Model',
      expiration_date: '2000-01-01',
    },
    {
      id: 'google/gemini-3-pro-image',
      name: 'Google: Gemini 3 Pro Image',
      description: 'Image generation and editing.',
      context_length: 32_000,
      architecture: {
        input_modalities: ['image', 'text'],
        output_modalities: ['image', 'text'],
      },
      supported_parameters: [],
      pricing: { prompt: '0.00003' },
    },
    {
      id: 'openai/gpt-audio',
      name: 'OpenAI: GPT Audio',
      description: 'Speech generation.',
      context_length: 128_000,
      architecture: {
        input_modalities: ['audio', 'text'],
        output_modalities: ['text', 'audio'],
      },
      supported_parameters: [],
      pricing: { prompt: '-1', completion: '-1' },
    },
  ],
}

function modelsResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function spine(ctx: Context) {
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SkillRegistry)
}

function stubAgent(ctx: Context, cwd?: string): Agent {
  const session = ctx.sessions.create(SessionId(`or-${Math.random()}`), {
    meta: cwd ? { cwd } : {},
  })
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

describe('catalog domain', () => {
  it('splits chat and media, filters aliases and retired models, and prices entries', () => {
    const parsed = parseModelsResponse(liveModels, Date.parse('2026-09-28'))
    expect(parsed.chat.map((model) => model.id)).toEqual(['openai/gpt-6.1-sol-pro'])
    expect(parsed.chat[0]).toMatchObject({
      name: 'OpenAI: GPT-6.1 Sol Pro',
      contextWindow: 1_050_000,
    })
    // The price line rides the description the picker shows.
    expect(parsed.chat[0]!.description).toContain('$2/M in · $10/M out')
    expect(parsed.chat[0]!.reasoning).toMatchObject({
      defaultEffort: 'medium',
      efforts: [
        { id: 'max', name: 'Max' },
        { id: 'xhigh', name: 'Extra High' },
        { id: 'high', name: 'High' },
        { id: 'medium', name: 'Medium' },
        { id: 'low', name: 'Low' },
      ],
    })
    expect(
      parsed.media.map(
        (model) => `${model.id}:${model.outputs.filter((output) => output !== 'text').join('+')}`,
      ),
    ).toEqual([
      'openai/gpt-6.1-sol-pro:',
      'google/gemini-3-pro-image:image',
      'openai/gpt-audio:audio',
    ])
    expect(parsed.media.find((model) => model.id === 'google/gemini-3-pro-image')).toMatchObject({
      inputs: ['image', 'text'],
      pricing: '$30/M in',
    })
    // Unknown rates (-1 sentinels) carry no price line.
    expect(parsed.media.find((model) => model.id === 'openai/gpt-audio')).not.toHaveProperty(
      'pricing',
    )
    expect(() => parseModelsResponse({})).toThrow('data array')
  })
})

describe('catalog fetch', () => {
  it('serves the live chat catalog plus extras, seeds on failure', async () => {
    const fetch = vi.fn(async () => modelsResponse(liveModels))
    const catalog = new OpenRouterCatalog({
      fetch: fetch as unknown as typeof fetch,
      extraModels: [{ id: 'vendor-a/fast', contextWindow: 8_000 }],
    })
    const chat = await catalog.chatModels()
    expect(chat.map((model) => model.id)).toEqual(['openai/gpt-6.1-sol-pro', 'vendor-a/fast'])
    expect((await catalog.mediaModels()).map((model) => model.id)).toContain('openai/gpt-audio')

    const dead = new OpenRouterCatalog({
      fetch: (async () => {
        throw new TypeError('offline')
      }) as unknown as typeof fetch,
    })
    expect(await dead.chatModels()).toEqual([])
    expect(await dead.mediaModels()).toEqual([])
  })
})

describe('media generator', () => {
  it('builds multimodal content and maps image output', async () => {
    const calls: Array<{ init?: RequestInit }> = []
    const generator = new OpenRouterMediaGenerator({
      apiKey: () => 'or-key',
      endpoint: 'https://openrouter.test/api/v1/chat/completions',
      fetch: (async (_url, init) => {
        calls.push({ init })
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'here you go',
                  images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as typeof fetch,
    })
    const result = await generator.generate({
      output: 'image',
      model: 'google/gemini-3-pro-image',
      prompt: 'a lighthouse at dusk',
      inputs: [{ kind: 'image', url: 'data:image/png;base64,QQ' }],
    })
    const body = JSON.parse(calls[0]!.init!.body as string)
    expect(body).toMatchObject({
      model: 'google/gemini-3-pro-image',
      modalities: ['text', 'image'],
      stream: false,
    })
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'a lighthouse at dusk' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QQ' } },
    ])
    expect(result.raw).toMatchObject({
      images: [{ image_url: { url: 'data:image/png;base64,QUJD' } }],
    })
    expect(result.text).toBe('here you go')
  })

  it('requests audio output with the configured voice and the routing preference', async () => {
    const calls: Array<{ init?: RequestInit }> = []
    const generator = new OpenRouterMediaGenerator({
      apiKey: () => 'or-key',
      endpoint: 'https://openrouter.test/api/v1/chat/completions',
      audioVoice: () => 'sage',
      extraBody: () => ({ provider: { order: ['DeepInfra'], allow_fallbacks: false } }),
      fetch: (async (_url, init) => {
        calls.push({ init })
        return new Response(
          JSON.stringify({
            choices: [{ message: { audio: { id: 'a1', data: 'QUJD', transcript: 'hi' } } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as typeof fetch,
    })
    const result = await generator.generate({
      output: 'audio',
      model: 'openai/gpt-audio',
      prompt: 'say hi',
      options: {},
    })
    const body = JSON.parse(calls[0]!.init!.body as string)
    expect(body.modalities).toEqual(['text', 'audio'])
    expect(body.audio).toEqual({ voice: 'sage', format: 'wav' })
    expect(body.provider).toEqual({ order: ['DeepInfra'], allow_fallbacks: false })
    expect(result.raw).toMatchObject({ audio: { data: 'QUJD' } })
  })

  it('maps documented video and audio input parts', () => {
    expect(
      buildContent({
        model: 'm',
        prompt: 'p',
        inputs: [{ kind: 'video', url: 'https://video.example/v.mp4' }],
      })[1],
    ).toEqual({ type: 'video_url', video_url: { url: 'https://video.example/v.mp4' } })
    const parts = buildContent({
      model: 'm',
      prompt: 'p',
      inputs: [{ kind: 'audio', url: 'data:audio/mp3;base64,TIxMw==' }],
    })
    expect(parts[1]).toMatchObject({ type: 'input_audio', input_audio: { format: 'mp3' } })
  })
})

describe('openrouter provider', () => {
  it('awaits profile pin edits and preserves disabled media and execution limits', async () => {
    const ctx = new Context()
    await spine(ctx)
    await ctx.plugin(Loader)
    const gate = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>()
    let edited: Record<string, unknown> | undefined
    ctx.provide('configEditor', {
      async edit(
        entry: { options: { config?: unknown }; update(value: unknown): Promise<void> },
        change: (
          current: Record<string, unknown>,
          inherited: Record<string, unknown>,
        ) => Record<string, unknown>,
      ) {
        entered.resolve()
        await gate.promise
        edited = change(entry.options.config as Record<string, unknown>, {})
        await entry.update({ config: edited })
        ctx.emit('app-boot/config-reload')
      },
    } as never)
    ctx.loader.builtins.router = {
      ...plugin,
      apply: (child: Context, config: Parameters<typeof plugin.apply>[1]) =>
        plugin.apply(child, config, { fetch: async () => modelsResponse(liveModels) }),
    }
    await ctx.loader.create({
      name: 'cordis:router',
      config: {
        apiKey: 'fixture-key',
        mediaEnabled: false,
        mediaTools: false,
        mediaTimeoutMs: 12000,
        maxFiles: 2,
      },
    })
    await ctx.loader.await()
    const agent = stubAgent(ctx)
    await ctx.agents.register(agent)
    let settled = false
    const command = ctx.commands
      .execute(agent, '/openrouter-provider deepinfra', [], new AbortController().signal)
      .then((result) => {
        settled = true
        return result
      })
    try {
      await entered.promise
      expect(settled).toBe(false)
      gate.resolve()
      expect((await command)?.result.kind).toBe('success')
      expect(edited).toMatchObject({
        pinnedProvider: 'deepinfra',
        mediaEnabled: false,
        mediaTools: false,
        mediaTimeoutMs: 12000,
        maxFiles: 2,
      })
      expect(ctx.tools.get('openrouter_generate')).toBeUndefined()
    } finally {
      gate.resolve()
      await ctx.fiber.dispose()
    }
  })
  it('registers the route without inventing offline models', async () => {
    const ctx = new Context()
    await spine(ctx)
    const handle = await ctx.plugin(plugin, { apiKey: 'k1' })
    expect(ctx.llm.listProviders().map((info) => info.id)).toContain('openrouter')
    await handle.dispose()
    expect(ctx.llm.listProviders().map((info) => info.id)).not.toContain('openrouter')
    await ctx.fiber.dispose()
    const offline = new Context()
    await spine(offline)
    plugin.apply(
      offline,
      { apiKey: 'k1' },
      {
        fetch: (async () => {
          throw new TypeError('offline')
        }) as typeof fetch,
      },
    )
    const offlineModels = await offline.llm.listModels('openrouter')
    expect(offlineModels).toEqual([])
    const resolved = await offline.llm.resolveModelInfo('openrouter', 'typesafe/jev-1.13')
    expect(resolved.context).toBeUndefined()
    await offline.fiber.dispose()
  })

  it('serves the live catalog with per-model reasoning when reachable', async () => {
    const ctx = new Context()
    await spine(ctx)
    plugin.apply(
      ctx,
      { apiKey: 'k1' },
      {
        fetch: (async () => modelsResponse(liveModels)) as typeof fetch,
      },
    )
    const models = await ctx.llm.listModels('openrouter')
    expect(models.map((model) => model.id)).toEqual(['openai/gpt-6.1-sol-pro'])
    const resolved = await ctx.llm.resolveModelInfo('openrouter', 'openai/gpt-6.1-sol-pro')
    expect(resolved.reasoning?.efforts.map((effort) => String(effort.id))).toEqual([
      'max',
      'xhigh',
      'high',
      'medium',
      'low',
    ])
    expect(String(resolved.reasoning?.defaultEffort)).toBe('medium')
    expect(resolved.description).toContain('$2/M in')
    await ctx.fiber.dispose()
  })

  it('pins the upstream provider: header, request preference, and command', async () => {
    const bodies: Record<string, unknown>[] = []
    let pin = 'DeepInfra'
    const ctx = new Context()
    await spine(ctx)
    plugin.apply(
      ctx,
      { apiKey: 'k1', pinnedProvider: { get: () => pin } as never },
      {
        fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
          const target = String(url)
          if (target.includes('/models')) return modelsResponse(liveModels)
          bodies.push(JSON.parse(init?.body as string))
          return new Response(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n` +
                `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
                'data: [DONE]\n\n',
            ),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        }) as typeof fetch,
      },
    )
    // The model window's group header shows the live pin.
    expect(ctx.llm.listProviders().find((info) => info.id === 'openrouter')?.name).toBe(
      'OpenRouter · DeepInfra',
    )

    for await (const chunk of ctx.llm.stream({
      provider: 'openrouter',
      model: 'openai/gpt-6.1-sol-pro',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })) {
      if (chunk.type === 'finish') break
    }
    expect(bodies[0]).toMatchObject({
      provider: { order: ['DeepInfra'], allow_fallbacks: false },
    })

    const agent = stubAgent(ctx)
    await ctx.agents.register(agent)
    const run = async (raw: string) => {
      const settled = await ctx.commands.execute(agent, raw, [], new AbortController().signal)
      if (settled === undefined) throw new Error(`${raw} not registered`)
      return settled.result
    }
    expect(await run('/openrouter-provider')).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('pinned to the upstream provider DeepInfra'),
    })
    // Unpinned requests let OpenRouter route per request, and the group
    // header drops the pin through the command's re-registration.
    pin = ''
    expect(await run('/openrouter-provider off')).toMatchObject({ kind: 'error' })
    for await (const chunk of ctx.llm.stream({
      provider: 'openrouter',
      model: 'openai/gpt-6.1-sol-pro',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })) {
      if (chunk.type === 'finish') break
    }
    expect(bodies[1]).not.toHaveProperty('provider')
    // No owning profile editor exists in this programmatic fixture; the command cannot claim persistence.
    expect(ctx.llm.listProviders().find((info) => info.id === 'openrouter')?.name).toBe(
      'OpenRouter · DeepInfra',
    )
    await ctx.fiber.dispose()
  })

  it('lists media models and generates through /openrouter-media', async () => {
    const generationCalls: unknown[] = []
    const outDir = await mkdtemp(join(tmpdir(), 'openrouter-media-'))
    const ctx = new Context()
    await spine(ctx)
    await ctx.plugin(LocalFileSystem)
    plugin.apply(
      ctx,
      { apiKey: 'k1', mediaOutDir: outDir },
      {
        fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
          const target = String(url)
          if (target.includes('/models')) return modelsResponse(liveModels)
          generationCalls.push(JSON.parse(init?.body as string))
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    images: [
                      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
                    ],
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }) as typeof fetch,
      },
    )
    const agent = stubAgent(ctx, outDir)
    await ctx.agents.register(agent)
    const run = async (raw: string) => {
      const settled = await ctx.commands.execute(agent, raw, [], new AbortController().signal)
      if (settled === undefined) throw new Error(`${raw} not registered`)
      return settled.result
    }
    const listed = await run('/openrouter-models')
    expect(listed).toMatchObject({
      kind: 'success',
      text: expect.stringMatching(
        /image \(1\)\s*\n\s*google\/gemini-3-pro-image — image\+text -> image\+text .* · \$30\/M in/,
      ),
    })

    const generated = await run(
      '/openrouter-media @google/gemini-3-pro-image a red boat --image https://f.test/boat.png',
    )
    expect(generated).toMatchObject({ kind: 'success', text: expect.stringContaining('image:') })
    expect(generationCalls).toHaveLength(1)
    const body = generationCalls[0] as { messages: { content: unknown[] }[] }
    expect(body.messages[0]!.content).toHaveLength(2)

    const unknown = await run('/openrouter-media @nope/such a prompt')
    expect(unknown).toMatchObject({ kind: 'error' })
    await ctx.fiber.dispose()
  })
})
