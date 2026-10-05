/** Consume installed declarations with normal NodeNext resolution and no development aliases. */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import ts from 'typescript'

const consumer = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Pass an installed independent consumer')
const names = []
for (const group of ['support', 'plugins'])
  for (const entry of await readdir(group))
    names.push(JSON.parse(await readFile(join(group, entry, 'package.json'), 'utf8')).name)
const source =
  names
    .map((name, index) => `import * as package${index} from ${JSON.stringify(name)};`)
    .join('\n') +
  '\nexport type InstalledModules = [' +
  names.map((_, index) => `typeof package${index}`).join(',') +
  '];\n'
const filename = join(consumer, 'declaration-consumer.ts')
await writeFile(filename, source)
const program = ts.createProgram([filename], {
  target: ts.ScriptTarget.ES2024,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
  strict: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
})
const errors = ts.getPreEmitDiagnostics(program)
if (errors.length) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => consumer,
      getNewLine: () => '\n',
    }),
  )
  process.exitCode = 1
} else
  console.log(
    `Installed declaration imports passed (${names.length} packages; NodeNext; no source aliases)`,
  )
