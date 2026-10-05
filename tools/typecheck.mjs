/** Check each owned compiler face; upstream source diagnostics belong to the upstream project's own programs. */

import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
for (const face of ['tsconfig.json', 'tsconfig.client.json']) {
  const filename = resolve(root, face)
  const read = ts.readConfigFile(filename, ts.sys.readFile)
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
  const owned = diagnostics.filter((diagnostic) => {
    if (!diagnostic.file) return true
    const path = relative(root, diagnostic.file.fileName)
    return !path.startsWith('..') && !isAbsolute(path)
  })
  failures += owned.length
  if (owned.length)
    console.error(
      ts.formatDiagnosticsWithColorAndContext(owned, {
        getCanonicalFileName: (x) => x,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
      }),
    )
  console.log(
    `${face}: ${owned.length} owned diagnostics (${diagnostics.length - owned.length} upstream diagnostics outside this project's scope)`,
  )
}
process.exitCode = failures ? 1 : 0
