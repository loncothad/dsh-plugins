/**
 * `NixSkillProvider`: a `SkillProvider` that lists `<name>/SKILL.md`
 * bundles from configured roots, keeps their parsed `metadata` on the
 * candidates (so `metadata.nix-packages` declarations ride along), and
 * appends the exact configured wrapper instruction to loaded content of
 * package-declaring skills.
 *
 * @module @loncothad/dsh-skill-nix-packages/provider
 */

import { readdir, readFile } from 'node:fs/promises'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
} from '@deepseek-ai/dsh-skill'
import { nixPackagesOf, nixWrapperInstruction, parseSkill } from './skill.ts'

/** Resolved provider options. */
export interface NixSkillProviderOptions {
  /** Absolute directory roots scanned one level deep for `<name>/SKILL.md`. */
  readonly roots: readonly string[]
  /** Lower ranks win duplicate skill names. */
  readonly rank: number
  /** Wrapper template (`{packages}` / `{command}`). */
  readonly wrapperTemplate: string
  /** Filesystem surface for tests. */
  readonly io?: NixSkillIo
}

/** Filesystem surface the provider reads through. */
export interface NixSkillIo {
  readdir(path: string): Promise<readonly string[]>
  readFile(path: string): Promise<string>
}

const defaultIo: NixSkillIo = {
  readdir: async (path) => readdir(path),
  readFile: async (path) => readFile(path, 'utf8'),
}

/** The nix-aware filesystem skill provider. */
export class NixSkillProvider implements SkillProvider {
  readonly name = 'nix-packages'

  private readonly io: NixSkillIo

  constructor(private readonly options: NixSkillProviderOptions) {
    this.io = options.io ?? defaultIo
  }

  async list(_options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    const candidates: SkillCandidate[] = []
    for (const root of this.options.roots) {
      let entries: readonly string[]
      try {
        entries = await this.io.readdir(root)
      } catch {
        continue
      }
      for (const entry of entries) {
        const path = `${root.replace(/\/$/, '')}/${entry}/SKILL.md`
        try {
          const parsed = await this.load(path)
          if (parsed === undefined) continue
          candidates.push({
            path,
            name: parsed.name.length > 0 ? parsed.name : entry,
            description: parsed.description,
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'custom',
            provider: this.name,
            rank: this.options.rank,
            locator: { path },
            metadata: parsed.metadata,
          })
        } catch {
          // An unreadable bundle is skipped; other roots still load.
        }
      }
    }
    return candidates
  }

  async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as { path?: unknown } | undefined
    if (locator === undefined || typeof locator.path !== 'string') return undefined
    const parsed = await this.load(locator.path)
    if (parsed === undefined) return undefined
    const packages = nixPackagesOf(parsed)
    const content =
      packages.length > 0
        ? `${parsed.content}\n\n${nixWrapperInstruction(packages, this.options.wrapperTemplate)}`
        : parsed.content
    return {
      path: locator.path,
      name: candidate.name,
      description: parsed.description,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'custom',
      provider: this.name,
      content,
      metadata: parsed.metadata,
    }
  }

  private async load(path: string) {
    let source: string
    try {
      source = await this.io.readFile(path)
    } catch {
      return undefined
    }
    const parsed = parseSkill(source)
    if (parsed.name.length === 0) return undefined
    return parsed
  }
}
