/** Emit plain ESM for every package; the published runtime requires no TypeScript loader. */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const selected = args.includes('--package') ? args[args.indexOf('--package') + 1] : undefined
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
    ),
  )
  return nested.flat()
}
for (const group of ['support', 'plugins']) {
  for (const entry of await readdir(join(root, group))) {
    if (selected && selected !== `${group}/${entry}`) continue
    const dir = join(root, group, entry)
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    await rm(join(dir, 'lib'), { recursive: true, force: true })
    for (const file of await files(join(dir, 'src'))) {
      if (
        !file.endsWith('.ts') ||
        file.endsWith('.d.ts') ||
        file.includes(`${join('src', 'client')}/`) ||
        file.includes(`${join('src', 'client')}\\`)
      )
        continue
      const target = join(dir, 'lib', relative(join(dir, 'src'), file).replace(/\.ts$/, '.js'))
      const output = ts.transpileModule(await readFile(file, 'utf8'), {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ESNext,
          rewriteRelativeImportExtensions: true,
          sourceMap: true,
          inlineSources: true,
        },
      })
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, output.outputText)
      if (output.sourceMapText) await writeFile(`${target}.map`, output.sourceMapText)
    }
    if (manifest.dsh?.client) {
      const bundled = await build({
        entryPoints: [join(dir, 'src/client/index.ts')],
        outfile: join(dir, 'lib/client.js'),
        metafile: true,
        bundle: true,
        format: 'cjs',
        platform: 'browser',
        target: 'es2023',
        sourcemap: true,
        external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
        alias: {
          '@loncothad/dsh-media-gen/client': join(root, 'support/media-gen/src/client.ts'),
          '@loncothad/dsh-plugin-runtime/client': join(
            root,
            'support/plugin-runtime/src/client.ts',
          ),
        },
        banner: {
          js: `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;`,
        },
        footer: { js: 'return module.exports;}});' },
      })
      const notices = new Map()
      for (const input of Object.keys(bundled.metafile.inputs)) {
        if (!input.replaceAll('\\', '/').includes('node_modules/')) continue
        let folder = dirname(resolve(root, input))
        while (dirname(folder) !== folder) {
          const metadata = join(folder, 'package.json')
          if (existsSync(metadata)) {
            const pkg = JSON.parse(readFileSync(metadata, 'utf8')),
              key = `${pkg.name}@${pkg.version}`
            // Nested format-only package.json files (for example zod/v4) do not own a license.
            if (!pkg.name) {
              folder = dirname(folder)
              continue
            }
            if (!notices.has(key)) {
              const names = readdirSync(folder).filter((name) =>
                /^(license|copying)(\.|$)/i.test(name),
              )
              if (!names.length)
                throw new Error(`Bundled dependency ${key} has no distributable license text`)
              notices.set(
                key,
                names.map((name) => readFileSync(join(folder, name), 'utf8')).join('\n'),
              )
            }
            break
          }
          folder = dirname(folder)
        }
      }
      if (notices.size)
        await writeFile(
          join(dir, 'lib/THIRD_PARTY_NOTICES.txt'),
          [...notices].map(([name, license]) => `${name}\n${license}`).join('\n\n'),
        )
    }
    console.log(`built ${manifest.name}`)
  }
}

// Emit declaration files only for owned modules; dependency projects retain their own compiler faces.
for (const face of ['tsconfig.json', 'tsconfig.client.json']) {
  const configPath = join(root, face)
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const program = ts.createProgram(
    parsed.fileNames.filter((file) => file.includes('/src/') || file.includes('\\src\\')),
    {
      ...parsed.options,
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      declarationMap: false,
      noEmitOnError: false,
      outDir: join(root, '.declarations'),
    },
  )
  const emitted = program.emit(undefined, (_filename, contents, _bom, _error, sources) => {
    const source = sources?.[0]?.fileName
    if (!source) return
    const normalized = relative(root, source).replaceAll('\\', '/')
    const match = /^(plugins|support)\/([^/]+)\/src\/(.+)\.ts$/.exec(normalized)
    if (!match || (selected && selected !== `${match[1]}/${match[2]}`)) return
    const target = join(root, match[1], match[2], 'lib/types', `${match[3]}.d.ts`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  })
  if (emitted.emitSkipped) throw new Error(`Declaration emission failed for ${face}`)
}
