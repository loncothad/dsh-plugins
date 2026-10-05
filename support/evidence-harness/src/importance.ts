/** Retention hints, never authority. The deterministic path uses observable message roles and tool outcomes. */
import { createHash } from 'node:crypto'
import type { Message } from '@deepseek-ai/dsh-llm'
export interface Importance {
  score: number
  reasons: string[]
  readFingerprint?: string
}
export function messageImportance(
  messages: readonly Message[],
  seenReads: Set<string>,
): Importance {
  let score = 30
  const reasons = new Set<string>(),
    calls: string[] = [],
    parts: string[] = []
  for (const message of messages) {
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .slice(0, 32768)
    if (message.role === 'user' && message.source.kind === 'user') {
      score = Math.max(score, 70)
      reasons.add('human-input')
      if (/\b(correction|actually|instead|amend|revised|supersed)/i.test(text)) {
        score = 95
        reasons.add('user-correction')
      }
      if (/\b(do not|must|never|required|constraint|only|without)\b/i.test(text)) {
        score = Math.max(score, 95)
        reasons.add('user-constraint')
      }
    }
    if (message.role === 'assistant')
      for (const block of message.content) if (block.type === 'tool-call') calls.push(block.name)
    if (message.role === 'tool') {
      if (message.isError) {
        score = Math.max(score, 90)
        reasons.add('failed-tool')
      } else {
        parts.push(text)
        reasons.add('successful-tool-output')
      }
      if (/\b(tests? failed|assertionerror|FAIL\s|failing test|exit code: [1-9])/i.test(text)) {
        score = Math.max(score, 90)
        reasons.add('test-failure')
      }
    }
    if (/\b(decided|decision:|we will|chosen approach)\b/i.test(text)) {
      score = Math.max(score, 75)
      reasons.add('decision')
    }
    if (
      /\b(open question|unresolved|blocked|failed approach|did not work|still failing)\b/i.test(
        text,
      )
    ) {
      score = Math.max(score, 85)
      reasons.add('open-or-failed-work')
    }
  }
  if (
    calls.some((name) =>
      /^(write_file|edit_file|apply_patch|delete_file|move_file|create_directory)$/.test(name),
    )
  ) {
    score = Math.max(score, 85)
    reasons.add('file-mutation')
  }
  const onlyReads =
    calls.length > 0 &&
    calls.every((name) => /^(read_file|list_dir|list_directory|glob|grep|search_files)$/.test(name))
  if (
    onlyReads &&
    parts.length &&
    score < 75 &&
    !reasons.has('failed-tool') &&
    !reasons.has('test-failure')
  ) {
    const fingerprint = createHash('sha256').update(parts.join('\n')).digest('hex')
    if (seenReads.has(fingerprint)) {
      score = Math.min(score, 10)
      reasons.add('duplicate-read')
    } else {
      seenReads.add(fingerprint)
      score = Math.min(score, 25)
      reasons.add('read-observation')
    }
    return { score, reasons: [...reasons], readFingerprint: fingerprint }
  }
  if (reasons.size === 1 && reasons.has('successful-tool-output')) score = 20
  return { score, reasons: [...reasons] }
}
