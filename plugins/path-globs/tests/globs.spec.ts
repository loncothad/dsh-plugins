import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolvePolicy } from '../src/config.ts'
import { expandGlobs, projectRoot } from '../src/engine.ts'
import { messagePatterns, splitPatterns } from '../src/patterns.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-globs-'))
  directories.push(root)
  await mkdir(join(root, '.git'))
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'ignored'))
  await writeFile(join(root, 'src/a.ts'), 'a')
  await writeFile(join(root, 'src/b.ts'), 'b')
  await writeFile(join(root, 'src/private.ts'), 'private')
  await writeFile(join(root, 'ignored/a.ts'), 'excluded')
  return root
}
it('uses root and nested ignore rules with correct negation and .ignore precedence', async () => {
  const root = await fixture()
  await writeFile(join(root, '.gitignore'), 'ignored/\n**/private.ts\n')
  await writeFile(join(root, 'src/.ignore'), '!private.ts\nb.ts\n')
  const policy = resolvePolicy({})
  expect(await projectRoot(join(root, 'src'), policy, AbortSignal.timeout(1000))).toBe(root)
  const value = await expandGlobs(join(root, 'src'), ['*.ts'], policy, AbortSignal.timeout(1000))
  expect(value.files).toEqual(['src/a.ts', 'src/private.ts'])
  expect(value.ignoreFiles).toEqual(['.gitignore', 'src/.ignore'])
  expect(value.patterns[0]?.files).toEqual(value.files)
  const ignored = await expandGlobs(
    root,
    ['**/*.ts'],
    resolvePolicy({ respectGitignore: false, respectIgnore: false }),
    AbortSignal.timeout(1000),
  )
  expect(ignored.files).toHaveLength(4)
})
it('deduplicates overlapping patterns, returns empty matches, and never silently truncates', async () => {
  const root = await fixture()
  expect(
    (await expandGlobs(root, ['src/*.ts', '**/a.ts'], resolvePolicy({}), AbortSignal.timeout(1000)))
      .files,
  ).toHaveLength(4)
  expect(
    (await expandGlobs(root, ['none/*.md'], resolvePolicy({}), AbortSignal.timeout(1000))).files,
  ).toEqual([])
  await expect(
    expandGlobs(root, ['**/*.ts'], resolvePolicy({ maxMatches: 1 }), AbortSignal.timeout(1000)),
  ).rejects.toThrow('match limit')
  await expect(
    expandGlobs(
      root,
      ['**/*.ts'],
      { ...resolvePolicy({}), maxResultBytes: 1 },
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow()
})
it('reads configured ignore filenames in order at the root and in child directories', async () => {
  const root = await fixture()
  await writeFile(join(root, '.gitignore'), 'src/private.ts\n')
  await writeFile(join(root, '.dshignore'), '!src/private.ts\nsrc/b.ts\n')
  await writeFile(join(root, '.customignore'), 'src/private.ts\n')
  await writeFile(join(root, 'src/.customignore'), '!private.ts\na.ts\n')
  const policy = resolvePolicy({
    additionalIgnoreFiles: ['.dshignore', '.customignore', '.dshignore', 'missing.ignore'],
  })
  const value = await expandGlobs(root, ['**/*.ts'], policy, AbortSignal.timeout(1000))
  expect(value.files).toEqual(['ignored/a.ts', 'src/private.ts'])
  expect(value.ignoreFiles).toEqual([
    '.customignore',
    '.dshignore',
    '.gitignore',
    'src/.customignore',
  ])
  const rootOnly = await expandGlobs(
    root,
    ['**/*.ts'],
    resolvePolicy({ ...policy, nestedIgnoreFiles: false }),
    AbortSignal.timeout(1000),
  )
  expect(rootOnly.files).toEqual(['ignored/a.ts', 'src/a.ts'])
  const reversed = await expandGlobs(
    root,
    ['**/*.ts'],
    resolvePolicy({
      ...policy,
      nestedIgnoreFiles: false,
      additionalIgnoreFiles: ['.customignore', '.dshignore'],
    }),
    AbortSignal.timeout(1000),
  )
  expect(reversed.files).toEqual(['ignored/a.ts', 'src/a.ts', 'src/private.ts'])
})
it('bypasses all ignore-file reads when disabled while retaining explicit exclusions', async () => {
  const root = await fixture()
  await writeFile(join(root, '.gitignore'), 'src/\n')
  await writeFile(join(root, '.ignore'), 'ignored/\n')
  // An invalid ignore-file target proves the disabled option does not read it.
  await mkdir(join(root, '.dshignore'))
  const policy = resolvePolicy({
    honorIgnoreFiles: false,
    additionalIgnoreFiles: ['.dshignore'],
    additionalExcludes: ['src/b.ts'],
  })
  const value = await expandGlobs(root, ['**/*.ts'], policy, AbortSignal.timeout(1000))
  expect(value.files).toEqual(['ignored/a.ts', 'src/a.ts', 'src/private.ts'])
  expect(value.ignoreFiles).toEqual([])
  await expect(
    expandGlobs(
      root,
      ['**/*.ts'],
      resolvePolicy({ ...policy, honorIgnoreFiles: true }),
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('regular file')
})
it('validates ignore filenames and applies the existing read limits to custom files', async () => {
  for (const name of [
    '../.ignore',
    'src/.ignore',
    'src\\.ignore',
    '*.ignore',
    '.',
    '..',
    '.git',
    '.gitignore',
    '.ignore',
    'CON',
    'file:stream',
    'bad\nname',
    '.dshignore ',
  ])
    expect(() => resolvePolicy({ additionalIgnoreFiles: [name] })).toThrow()
  expect(() =>
    resolvePolicy({ additionalIgnoreFiles: Array.from({ length: 33 }, (_, i) => `.ignore-${i}`) }),
  ).toThrow()
  const root = await fixture()
  await writeFile(join(root, '.dshignore'), 'x'.repeat(1100))
  await expect(
    expandGlobs(
      root,
      ['**/*.ts'],
      resolvePolicy({ additionalIgnoreFiles: ['.dshignore'], maxIgnoreBytes: 1024 }),
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('byte limit')
  await rm(join(root, '.dshignore'))
  await symlink(join(root, 'src/a.ts'), join(root, '.dshignore'), 'file')
  await expect(
    expandGlobs(
      root,
      ['**/*.ts'],
      resolvePolicy({ additionalIgnoreFiles: ['.dshignore'] }),
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('symlinks')
})
it('rejects escaping patterns and skips symlinks', async () => {
  const root = await fixture(),
    outside = await mkdtemp(join(tmpdir(), 'dsh-globs-outside-'))
  directories.push(outside)
  await writeFile(join(outside, 'secret.ts'), 'secret')
  await symlink(outside, join(root, 'linked'), 'dir')
  const value = await expandGlobs(root, ['**/*.ts'], resolvePolicy({}), AbortSignal.timeout(1000))
  expect(value.files.some((file) => file.includes('linked'))).toBe(false)
  await expect(
    expandGlobs(root, ['../*.ts'], resolvePolicy({}), AbortSignal.timeout(1000)),
  ).rejects.toThrow('traverse')
  const controller = new AbortController()
  controller.abort()
  await expect(
    expandGlobs(root, ['**/*.ts'], resolvePolicy({}), controller.signal),
  ).rejects.toThrow()
})
it('recognizes human file patterns without expanding URLs or fenced examples', () => {
  expect(
    messagePatterns(
      'Review `src/**/*.ts` and @tests/*.test.ts, not https://host/*.ts\n```js\nexample/*.ts\n```',
      true,
    ),
  ).toEqual(['src/**/*.ts', 'tests/*.test.ts'])
  expect(splitPatterns('"folder with spaces/*.ts" src/*.{ts,tsx}')).toEqual([
    'folder with spaces/*.ts',
    'src/*.{ts,tsx}',
  ])
})

it('expands admitted user messages without changing original blocks, attachments, or native message identity', async () => {
  const { Context } = await import('@deepseek-ai/cordis'),
    { mountAgentLoopTestDependencies } = await import('@deepseek-ai/dsh-agent-loop-testkit'),
    { default: AgentLoop } = await import('@deepseek-ai/dsh-agent-loop'),
    { default: Commands } = await import('@deepseek-ai/dsh-commands'),
    { SessionId } = await import('@deepseek-ai/dsh-session'),
    { LlmAdapter, createUserMessage } = await import('@deepseek-ai/dsh-llm'),
    { apply } = await import('../src/index.ts')
  const root = await fixture(),
    ctx = new Context()
  let seen = ''
  try {
    await writeFile(join(root, '.dshignore'), 'src/private.ts\n')
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Commands)
    await ctx.plugin(AgentLoop, { agents: [] })
    await apply(ctx, { additionalIgnoreFiles: ['.dshignore'] })
    class Provider extends LlmAdapter {
      async resolveModel(provider: string, id: string) {
        return {
          provider,
          id,
          name: id,
          context: { contextWindow: 128000 },
          defaultMaxTokens: 4096,
        }
      }
      async *stream(
        options: import('@deepseek-ai/dsh-llm').GenerateOptions,
      ): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk> {
        seen = options.messages
          .flatMap((message) => message.content)
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['fixture'], new Provider())
    const agent = await ctx.agentLoop.create(
        SessionId('glob-admission'),
        { provider: 'fixture', model: 'fixture' },
        { cwd: root },
      ),
      message = createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Inspect src/*.ts' }],
      })
    agent.followup(message)
    await agent.whenIdle()
    expect(message.content).toEqual([{ type: 'text', text: 'Inspect src/*.ts' }])
    expect(seen).toContain('src/a.ts')
    expect(seen).not.toContain('src/private.ts')
    const admitted = agent.session
      .snapshotEvents()
      .find((event) => event.type === 'user/message' && event.data.id === message.id)
    expect(admitted?.type === 'user/message' && admitted.data.content).toEqual(message.content)
    const expansion = agent.session
      .snapshotEvents()
      .find((event) => event.type === 'user/message' && event.data.source.kind === 'path-globs')
    expect(expansion?.type === 'user/message' && expansion.data.source).toMatchObject({
      form: 'notice',
      originalMessageId: message.id,
    })
    const preview = await ctx.commands.execute(
      agent,
      '/glob preview src/*.ts',
      [],
      new AbortController().signal,
    )
    expect(preview?.result.kind).toBe('success')
    expect(preview?.result.text).not.toContain('src/private.ts')
    const status = await ctx.commands.execute(
      agent,
      '/glob status',
      [],
      new AbortController().signal,
    )
    expect(JSON.parse(status?.result.text ?? '{}')).toMatchObject({
      honorIgnoreFiles: true,
      additionalIgnoreFiles: ['.dshignore'],
    })
  } finally {
    await ctx.fiber.dispose()
  }
})
