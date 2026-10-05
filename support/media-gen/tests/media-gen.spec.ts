import { describe, expect, it } from 'vitest'
import {
  acceptsInput,
  harvestMedia,
  type MediaCatalogModel,
  MediaExecutionError,
  type MediaGenerator,
  type MediaIo,
  modalityOfUrl,
  parseMediaInvocation,
  registerMediaSurfaces,
  runMediaGeneration,
  transitionsLabel,
} from '../src/index.ts'

describe('transitions vocabulary', () => {
  const imageToVideo: MediaCatalogModel = {
    id: 'fal-ai/veo',
    name: 'Veo',
    outputs: ['video'],
    inputs: ['image'],
  }
  it('labels and guards transitions per model', () => {
    expect(transitionsLabel(imageToVideo)).toBe('image -> video')
    expect(transitionsLabel({ id: 'x', name: 'X', outputs: ['image'] })).toBe('text -> image')
    expect(acceptsInput(imageToVideo, 'image')).toBe(true)
    expect(acceptsInput(imageToVideo, 'video')).toBe(false)
    expect(acceptsInput(imageToVideo, 'text')).toBe(true)
  })

  it('classifies URLs and data URLs by extension and mime', () => {
    expect(modalityOfUrl('https://cdn.test/out.png')).toBe('image')
    expect(modalityOfUrl('https://cdn.test/v.mp4?x=1')).toBe('video')
    expect(modalityOfUrl('https://cdn.test/a.wav')).toBe('audio')
    expect(modalityOfUrl('https://cdn.test/model.glb')).toBe('3d')
    expect(modalityOfUrl('https://cdn.test/page')).toBeUndefined()
    expect(modalityOfUrl('data:video/mp4;base64,AAAA')).toBe('video')
  })
})

describe('result harvesting', () => {
  it('reads the known output keys across router schemas', () => {
    expect(harvestMedia({ image_url: 'https://f.test/1.png' }).map((a) => a.modality)).toEqual([
      'image',
    ])
    expect(
      harvestMedia({ images: [{ url: 'https://f.test/a.png' }, 'https://f.test/b.jpg'] }),
    ).toHaveLength(2)
    expect(harvestMedia({ video: { url: 'https://f.test/v.mp4' } }).map((a) => a.modality)).toEqual(
      ['video'],
    )
    expect(harvestMedia({ audio: 'https://f.test/a.mp3' }).map((a) => a.modality)).toEqual([
      'audio',
    ])
  })

  it('walks declared output containers and deduplicates artifacts', () => {
    const url = 'https://f.test/1.png'
    const harvested = harvestMedia({
      output: { images: [url, url, 'data:image/webp;base64,QUJD'] },
      docs: 'https://f.test/readme',
    })
    expect(harvested).toHaveLength(2)
    expect(harvested[1]).toMatchObject({ mime: 'image/webp', modality: 'image', base64: 'QUJD' })
  })
})

describe('command parsing', () => {
  it('splits model, prompt, inputs, and options', () => {
    const parsed = parseMediaInvocation(
      '@fal-ai/nano-banana/edit a lighthouse at dusk --image C:/pics/boat.png --options {"num_images":2}',
    )
    expect(parsed.model).toBe('fal-ai/nano-banana/edit')
    expect(parsed.prompt).toBe('a lighthouse at dusk')
    expect(parsed.request.inputs).toEqual([{ kind: 'image', url: 'C:/pics/boat.png' }])
    expect(parsed.request.options).toEqual({ num_images: 2 })
  })

  it('supports video and audio inputs and flags errors', () => {
    const parsed = parseMediaInvocation('animate it --video clip.mp4 --audio voice.wav')
    expect(parsed.request.inputs).toEqual([
      { kind: 'video', url: 'clip.mp4' },
      { kind: 'audio', url: 'voice.wav' },
    ])
    expect(parseMediaInvocation('--image').error).toContain('--image')
    expect(parseMediaInvocation('--options {nope').error).toContain('--options')
    expect(parseMediaInvocation('@model-only-but-long enough prompt').model).toBe(
      'model-only-but-long',
    )
    expect(parseMediaInvocation('draw a red boat').model).toBeUndefined()
  })
})

describe('executor', () => {
  const io: MediaIo = {
    async mkdir() {},
    async write() {
      return { async rollback() {} }
    },
    async readDataUrl(path: string) {
      return `data:image/png;base64,${Buffer.from(`bytes-of:${path}`).toString('base64')}`
    },
  }

  it('inlines local inputs, harvests, downloads remote artifacts, and writes files', async () => {
    const seen: unknown[] = []
    const generator: MediaGenerator = {
      async generate(request) {
        seen.push(request)
        return { files: [], raw: { video: { url: 'https://f.test/out.mp4' } } }
      },
    }
    const writes: string[] = []
    const result = await runMediaGeneration(
      {
        outDir: 'out',
        generator,
        io: {
          ...io,
          async write(path) {
            writes.push(path)
            return { async rollback() {} }
          },
        },
        fetch: (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch,
        stem: 'gen',
      },
      {
        output: 'video',
        model: 'fal-ai/veo',
        prompt: 'animate',
        inputs: [{ kind: 'image', url: 'src/boat.png' }],
      },
    )
    expect(writes.map((path) => path.replaceAll('\\', '/'))).toEqual([
      expect.stringMatching(/^out\/gen-fal-ai-veo-[a-f0-9-]{36}-01\.mp4$/),
    ])
    expect(result.files[0]).toMatchObject({ modality: 'video', mime: 'video/mp4' })
    // The local input reached the generator as a data: URL.
    const request = seen[0] as { inputs?: { url: string }[] }
    expect(request.inputs![0]!.url.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('writes inline data URLs without a download and classifies empty output', async () => {
    const writes: string[] = []
    await runMediaGeneration(
      {
        outDir: 'out',
        generator: {
          async generate() {
            return { files: [], raw: { image_url: 'data:image/png;base64,QUJD' } }
          },
        },
        io: {
          ...io,
          async write(path) {
            writes.push(path)
            return { async rollback() {} }
          },
        },
      },
      { output: 'image', model: 'm', prompt: 'p' },
    )
    expect(writes[0]!.endsWith('.png')).toBe(true)
    expect(Buffer.from('QUJD', 'base64').length).toBe(3)

    await expect(
      runMediaGeneration(
        {
          outDir: 'out',
          generator: {
            async generate() {
              return { files: [], raw: { nothing: true } }
            },
          },
          io,
        },
        { output: 'image', model: 'm', prompt: 'p' },
      ),
    ).rejects.toBeInstanceOf(MediaExecutionError)
  })
})

describe('surfaces', () => {
  it('registers tool, skill, and commands; generates with transition guards', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { default: CommandRuntime } = await import('@deepseek-ai/dsh-commands')
    const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
    const { default: ToolRuntime } = await import('@deepseek-ai/dsh-tools')
    const { default: AgentRegistry } = await import('@deepseek-ai/dsh-agent')
    const { default: SessionStore, SessionId } = await import('@deepseek-ai/dsh-session')
    const { unsupportedInbox } = await import('@deepseek-ai/dsh-agent-loop-testkit')
    const { default: SkillRegistry } = await import('@deepseek-ai/dsh-skill')

    const catalog: MediaCatalogModel[] = [
      {
        id: 'router/image-x',
        name: 'Image X',
        outputs: ['image'],
        inputs: ['text', 'image'],
        pricing: '$0.15 per image',
      },
      { id: 'router/vid-y', name: 'Vid Y', outputs: ['video'], inputs: ['image'] },
    ]
    const requests: unknown[] = []
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SkillRegistry)
    registerMediaSurfaces(ctx, {
      provider: 'test',
      label: 'Test Router',
      outDir: 'out',
      models: async () => catalog,
      defaultModel: () => 'router/image-x',
      generator: {
        async generate(request) {
          requests.push(request)
          return { files: [], raw: { image_url: 'data:image/png;base64,QUJD' } }
        },
      },
      io: {
        async mkdir() {},
        async write() {
          return { async rollback() {} }
        },
        async readDataUrl(path: string) {
          return `data:image/png;base64,${Buffer.from(`bytes-of:${path}`).toString('base64')}`
        },
      },
    })

    const session = ctx.sessions.create(SessionId(`media-${Math.random()}`))
    let status = 'idle' as const
    const agent = {
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
      runMaintenance: (task: (signal: AbortSignal) => unknown) =>
        task(new AbortController().signal),
      whenIdle() {
        return Promise.resolve()
      },
    } as never
    await ctx.agents.register(agent)

    const run = async (raw: string) => {
      const settled = await ctx.commands.execute(agent, raw, [], new AbortController().signal)
      if (settled === undefined) throw new Error(`${raw} not registered`)
      return settled.result
    }
    const listed = await run('/test-models')
    expect(listed).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('image -> video'),
    })
    expect(listed).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('· $0.15 per image'),
    })

    const generated = await run('/test-media @router/vid-y animate the boat --image boat.png')
    expect(generated).toMatchObject({ kind: 'success', text: expect.stringContaining('image:') })
    expect((requests[0] as { inputs?: unknown[] }).inputs).toHaveLength(1)

    // A video model that accepts no text-only path still rejects wrong input kinds.
    const rejected = await run('/test-media @router/image-x edit --video clip.mp4')
    expect(rejected).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('does not accept video input'),
    })
    await ctx.fiber.dispose()
  })
})
