/** Test the actual shipped worker module; Vite transforms cannot enter Node worker isolates. */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
for (const packagePath of ['support/execution-core', 'support/evidence-store']) {
  const dir = resolve(root, packagePath)
  await mkdir(resolve(dir, 'lib'), { recursive: true })
  for (const file of await readdir(resolve(dir, 'src'))) {
    if (!file.endsWith('.ts')) continue
    const source = await readFile(resolve(dir, 'src', file), 'utf8')
    const output = ts.transpileModule(source, {
      fileName: resolve(dir, 'src', file),
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
        rewriteRelativeImportExtensions: true,
        sourceMap: true,
        inlineSources: true,
      },
    })
    const target = resolve(dir, 'lib', file.replace(/\.ts$/, '.js'))
    await writeFile(target, output.outputText)
    if (output.sourceMapText) await writeFile(`${target}.map`, output.sourceMapText)
  }
}
