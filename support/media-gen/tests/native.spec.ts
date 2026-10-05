import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  mountAgentLoopTestDependencies,
  unsupportedInbox,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { afterEach, expect, it } from 'vitest'
import { registerMediaSurfaces, runMediaGeneration } from '../src/index.ts'
import { scopedMediaIo } from '../src/scoped-io.ts'
import type { MediaSurfacesOptions } from '../src/surfaces.ts'

const contexts: Context[] = [],
  directories: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function harness(flags: Partial<MediaSurfacesOptions> = {}, readonly = false) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-native-media-'))
  directories.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(LocalFileSystem)
  if (readonly) await ctx.plugin(SandboxPolicy, { mode: 'read-only' })
  const session = ctx.sessions.create(SessionId('native-media'), { meta: { cwd: dir } })
  const agent = {
    id: session.id,
    session,
    ctx,
    options: {},
    inbox: unsupportedInbox(),
    status: 'idle',
    send() {},
    followup() {},
    steer() {},
    inject() {},
    cancel() {},
    async whenIdle() {},
    runMaintenance: (task: (signal: AbortSignal) => Promise<unknown>) =>
      task(new AbortController().signal),
  } as Agent
  await ctx.agents.register(agent)
  const requests: {
    signal?: AbortSignal
    model: string
    output: string
    options?: Readonly<Record<string, unknown>>
    inputs?: readonly { url: string }[]
  }[] = []
  registerMediaSurfaces(ctx, {
    provider: 'fixture',
    label: 'Fixture',
    outDir: 'generated',
    defaultModel: () => 'model/image',
    models: async () => [
      { id: 'model/image', name: 'Image', outputs: ['image'], inputs: ['text', 'image'] },
    ],
    generator: {
      async generate(request, signal) {
        requests.push({
          signal,
          model: request.model,
          output: request.output,
          options: request.options,
          inputs: request.inputs,
        })
        return {
          files: [],
          ...(request.output === 'text' ? { text: 'Recognized words.' } : {}),
          raw:
            request.output === 'audio'
              ? { audio_url: 'data:audio/wav;base64,QUJD' }
              : { image_url: 'data:image/png;base64,QUJD' },
        }
      },
    },
    ...flags,
  })
  const execute = (args: unknown, signal = new AbortController().signal) =>
    ctx.tools.execute({
      callId: ToolCallId('native-media-call'),
      name: 'fixture_generate',
      arguments: args,
      agent,
      signal,
    })
  return { ctx, agent, dir, requests, execute }
}

it('executes through the real tool registry, renders canonical content, scopes files, and preserves cancellation', async () => {
  const f = await harness()
  await writeFile(join(f.dir, 'source.png'), 'SOURCE')
  const signal = new AbortController().signal
  const result = await f.execute({ prompt: 'Edit this picture', images: ['source.png'] }, signal)
  expect(result).toMatchObject({ isError: false, value: { files: [{ modality: 'image' }] } })
  if (result.isError) throw new Error(JSON.stringify(result))
  const value = result.value as { files: { path: string }[] }
  expect(result.content).toEqual([
    { type: 'text', text: expect.stringContaining(value.files[0]!.path) },
  ])
  expect(await readFile(join(f.dir, value.files[0]!.path), 'utf8')).toBe('ABC')
  expect(f.requests[0]?.inputs?.[0]?.url).toBe('data:image/png;base64,U09VUkNF')
  expect(f.requests[0]?.signal).toBeInstanceOf(AbortSignal)
  const abort = new AbortController()
  abort.abort(new Error('cancelled'))
  const cancelled = await f.execute({ prompt: 'Do not dispatch' }, abort.signal)
  expect(cancelled.isError).toBe(true)
  expect(f.requests).toHaveLength(1)
})

it('refuses escaped input paths, out-of-workspace output, and read-only writes before provider dispatch', async () => {
  const f = await harness()
  expect((await f.execute({ prompt: 'Edit', images: ['../private.png'] })).isError).toBe(true)
  expect(f.requests).toHaveLength(0)
  const outside = await harness({ outDir: '../other-workspace' })
  expect((await outside.execute({ prompt: 'Generate' })).isError).toBe(true)
  expect(outside.requests).toHaveLength(0)
  const restricted = await harness({}, true)
  expect((await restricted.execute({ prompt: 'Generate' })).isError).toBe(true)
  expect(restricted.requests).toHaveLength(0)
})

it('mounts only requested surfaces and never advertises a skill for a disabled tool', async () => {
  const f = await harness({ toolsEnabled: false, commandsEnabled: false })
  expect(f.ctx.tools.get('fixture_generate')).toBeUndefined()
  expect(f.ctx.commands.find(f.agent, 'fixture-media')).toBeUndefined()
  const commandOnly = await harness({ toolsEnabled: false })
  expect(commandOnly.ctx.commands.find(commandOnly.agent, 'fixture-media')).toBeDefined()
  expect(commandOnly.ctx.tools.get('fixture_generate')).toBeUndefined()
})

it('does not overwrite earlier generations and bounds inline and streamed output before publication', async () => {
  const f = await harness()
  const first = await f.execute({ prompt: 'First' }),
    second = await f.execute({ prompt: 'Second' })
  const paths = [first, second].map((result) => {
    if (result.isError) throw new Error(JSON.stringify(result))
    return (result.value as { files: { path: string }[] }).files[0]!.path
  })
  expect(paths[0]).not.toBe(paths[1])
  const writes: string[] = []
  const options = {
    outDir: 'out',
    maxOutputBytes: 2,
    io: {
      async mkdir() {},
      async write(path: string) {
        writes.push(path)
        return { async rollback() {} }
      },
    },
    generator: {
      async generate() {
        return { files: [], raw: { image_url: 'data:image/png;base64,QUJD' } }
      },
    },
  }
  await expect(
    runMediaGeneration(options, { output: 'image', model: 'm', prompt: 'p' }),
  ).rejects.toThrow('byte limit')
  expect(writes).toEqual([])
  await expect(
    runMediaGeneration(
      {
        ...options,
        generator: {
          async generate() {
            return { files: [], raw: { image_url: 'https://cdn.example/output.png' } }
          },
        },
        fetch: async () => new Response('OVER LIMIT'),
      },
      { output: 'image', model: 'm', prompt: 'p' },
    ),
  ).rejects.toThrow('byte limit')
  expect(writes).toEqual([])
  await expect(
    runMediaGeneration(
      {
        ...options,
        maxOutputBytes: 4,
        generator: {
          async generate() {
            return {
              files: [],
              raw: {
                images: [
                  { url: 'data:image/png;base64,QUJD' },
                  { url: 'data:image/png;base64,REVG' },
                ],
              },
            }
          },
        },
      },
      { output: 'image', model: 'm', prompt: 'p' },
    ),
  ).rejects.toThrow('byte limit')
  expect(writes).toEqual([])
})

it('uses the requested audio default for text-to-audio and refuses contradictory model output', async () => {
  const f = await harness({
    defaultModel: (output) => (output === 'audio' ? 'model/voice' : 'model/image'),
    models: async () => [
      { id: 'model/image', name: 'Image', outputs: ['image'], inputs: ['text'] },
      { id: 'model/voice', name: 'Voice', outputs: ['audio'], inputs: ['text'] },
    ],
  })
  expect((await f.execute({ output: 'audio', prompt: 'Say hello' })).isError).toBe(false)
  expect(f.requests[0]).toMatchObject({ model: 'model/voice', output: 'audio' })
  expect(
    (await f.execute({ model: 'model/image', output: 'audio', prompt: 'Mismatch' })).isError,
  ).toBe(true)
  expect(f.requests).toHaveLength(1)
})

it('supports asset-only transcription in a read-only session without publishing a file', async () => {
  const f = await harness(
    {
      defaultModel: () => 'model/transcribe',
      models: async () => [
        { id: 'model/transcribe', name: 'Transcribe', outputs: ['text'], inputs: ['audio'] },
      ],
    },
    true,
  )
  await writeFile(join(f.dir, 'voice.mp3'), 'VOICE')
  const result = await f.execute({ output: 'text', audio: 'voice.mp3' })
  expect(result).toMatchObject({ isError: false, value: { files: [], text: 'Recognized words.' } })
  expect(result.content).toEqual([{ type: 'text', text: '[fixture]\nRecognized words.' }])
  expect(f.requests).toHaveLength(1)
})

it('rejects provider-advertised option values before a generation is dispatched', async () => {
  const f = await harness({
    defaultModel: () => 'video/model',
    models: async () => [
      {
        id: 'video/model',
        name: 'Video',
        outputs: ['video'],
        inputs: ['text'],
        parameters: { duration: { type: 'number', values: [4, 8] } },
      },
    ],
  })
  expect(
    (await f.execute({ output: 'video', prompt: 'p', options: { duration: 6 } })).isError,
  ).toBe(true)
  expect(f.requests).toEqual([])
})

for (const failure of ['disk', 'cancel'] as const) {
  it(`rolls back a native generation after ${failure} failure`, async () => {
    const abort = new AbortController()
    let writes = 0
    const f = await harness({
      generator: {
        async generate() {
          return {
            files: [],
            raw: {
              images: [
                { url: 'data:image/png;base64,QUJD' },
                { url: 'data:image/png;base64,REVG' },
              ],
            },
          }
        },
      },
      async ioFor(agent, signal) {
        const io = await scopedMediaIo(agent.ctx, agent, signal, 'generated', 1024)
        return {
          ...io,
          async write(path, bytes) {
            if (++writes === 2) throw new Error('disk failed')
            const receipt = await io.write(path, bytes)
            if (failure === 'cancel') abort.abort(new Error('cancelled after write'))
            return receipt
          },
        }
      },
    })
    await writeFile(join(f.dir, 'keep.txt'), 'existing')
    expect((await f.execute({ prompt: 'Generate two files' }, abort.signal)).isError).toBe(true)
    expect(await readdir(join(f.dir, 'generated'))).toEqual([])
    expect(await readFile(join(f.dir, 'keep.txt'), 'utf8')).toBe('existing')
    expect(writes).toBe(failure === 'disk' ? 2 : 1)
  })
}

it('requires an explicit model after the operator clears the saved default', async () => {
  const f = await harness({ defaultModel: () => '' })
  expect((await f.execute({ output: 'image', prompt: 'Use the default' })).isError).toBe(true)
  expect(f.requests).toHaveLength(0)
})

it('merges saved model defaults with tool and human-command overrides before dispatch', async () => {
  const f = await harness({
    defaultModel: () => 'video/model',
    defaultOptions: () => ({ duration: 4, resolution: '720p' }),
    models: async () => [
      {
        id: 'video/model',
        name: 'Video',
        outputs: ['video'],
        inputs: ['text'],
        parameters: { duration: { type: 'number', values: [4, 8] } },
      },
    ],
  })
  expect(
    (await f.execute({ output: 'video', prompt: 'p', options: { duration: 8 } })).isError,
  ).toBe(false)
  expect(f.requests[0]?.options).toEqual({ duration: 8, resolution: '720p' })
  const command = await f.ctx.commands.execute(
    f.agent,
    '/fixture-media animate --output video --options {"duration":8}',
    [],
    new AbortController().signal,
  )
  expect(command?.result.kind).toBe('success')
  expect(f.requests[1]?.options).toEqual({ duration: 8, resolution: '720p' })
})

it('rejects invalid saved model defaults before a generation is dispatched', async () => {
  const f = await harness({
    defaultOptions: () => ({ duration: 6 }),
    models: async () => [
      {
        id: 'model/image',
        name: 'Image',
        outputs: ['image'],
        inputs: ['text'],
        parameters: { duration: { type: 'number', values: [4, 8] } },
      },
    ],
  })
  expect((await f.execute({ prompt: 'p' })).isError).toBe(true)
  expect(f.requests).toEqual([])
})

it('reads quoted workspace filenames through the native human command with options before the prompt', async () => {
  const f = await harness()
  await writeFile(join(f.dir, 'source frame.png'), 'SOURCE')
  const result = await f.ctx.commands.execute(
    f.agent,
    '/fixture-media @model/image --image "source frame.png" --options {"steps":4} edit the picture',
    [],
    new AbortController().signal,
  )
  expect(result?.result.kind, JSON.stringify(result?.result)).toBe('success')
  expect(f.requests[0]?.inputs?.[0]?.url).toBe('data:image/png;base64,U09VUkNF')
  expect(f.requests[0]?.options).toEqual({ steps: 4 })
})
it('publishes real durable image references through the native tool projection', async () => {
  const { LocalAttachmentStore } = await import('@deepseek-ai/dsh-attachment-local')
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
  const f = await harness({
    generator: {
      async generate() {
        return { files: [], raw: { image_url: `data:image/png;base64,${png}` } }
      },
    },
  })
  new LocalAttachmentStore(f.ctx, { dshHome: join(f.dir, 'attachment-home') })
  const result = await f.execute({ prompt: 'generate' })
  expect(result.isError, JSON.stringify(result)).toBe(false)
  const image = result.content.find((block) => block.type === 'image')
  expect(image?.type).toBe('image')
  if (image?.type === 'image')
    expect((await f.ctx.attachments.readImage(image.attachment)).data.byteLength).toBeGreaterThan(0)
})
it('exposes complete model schemas without generating and removes the metadata tool with tools disabled', async () => {
  const schema = {
    type: 'object',
    required: ['image_url'],
    properties: {
      image_url: { type: 'string' },
      strength: { type: 'number', minimum: 0, maximum: 1 },
    },
  }
  const f = await harness({
    describeModel: async () => ({
      id: 'model/image',
      name: 'Image',
      protocol: 'fal',
      outputs: ['image'],
      inputSchema: schema,
    }),
  })
  const result = await f.ctx.tools.execute({
    callId: ToolCallId('info'),
    name: 'fixture_model_info',
    arguments: { model: 'model/image' },
    agent: f.agent,
    signal: new AbortController().signal,
  })
  expect(result.isError).toBe(false)
  expect(result.value).toMatchObject({ models: [{ protocol: 'fal', inputSchema: schema }] })
  expect(f.requests).toHaveLength(0)
  const disabled = await harness({ toolsEnabled: false })
  const refused = await disabled.ctx.tools.execute({
    callId: ToolCallId('disabled-info'),
    name: 'fixture_model_info',
    arguments: {},
    agent: disabled.agent,
    signal: new AbortController().signal,
  })
  expect(refused.isError).toBe(true)
})
