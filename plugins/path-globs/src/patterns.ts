/** Tokenization never evaluates shell syntax, reads file contents, or treats URLs as paths. */
export function splitPatterns(text: string): string[] {
  if (text.length > 65536) throw new Error('Glob input exceeds 64 KiB')
  const values: string[] = [],
    quoted = /`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|([^\s]+)/g
  for (const match of text.matchAll(quoted)) {
    const value = match[1] ?? match[2] ?? match[3] ?? match[4]!
    if (value) values.push(value)
  }
  return values
}
export function messagePatterns(text: string, skipCodeBlocks: boolean): string[] {
  const source = skipCodeBlocks
    ? text.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)/g, '\n')
    : text
  return [
    ...new Set(
      splitPatterns(source)
        .map((value) => value.replace(/^@/, '').replace(/[,:;.!]+$/, ''))
        .filter(
          (value) =>
            !value.includes('://') &&
            !value.includes('\0') &&
            /[*?[{]/.test(value) &&
            (/\//.test(value) ||
              /^\*\*?(?:\.|$)/.test(value) ||
              /\.[a-zA-Z0-9*?{}[\],-]+$/.test(value)),
        ),
    ),
  ]
}
