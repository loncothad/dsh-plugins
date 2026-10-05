import { editableConfig, managedApply } from '@loncothad/dsh-plugin-runtime'
/**
 * Skill-declared Nix packages: a `SkillProvider` that surfaces
 * `metadata.nix-packages` declarations from SKILL.md frontmatter and
 * appends the exact configured `nix shell` wrapper instruction to loaded
 * package-declaring skills, plus the `/nix-skills` command.
 *
 * @module @loncothad/dsh-skill-nix-packages
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'
import { NixSkillProvider } from './provider.ts'
import { expandWrapper, nixPackagesOf } from './skill.ts'

export type { NixSkillIo, NixSkillProviderOptions } from './provider.ts'
export { NixSkillProvider } from './provider.ts'
export {
  expandWrapper,
  frontmatterOf,
  nixPackagesOf,
  nixWrapperInstruction,
  parseFrontmatter,
  parseSkill,
  quoteCommand,
} from './skill.ts'

/** Default wrapper pattern; `{packages}` expands in `nixpkgs#pkg` form. */
export const DEFAULT_WRAPPER_TEMPLATE = 'nix shell {packages} -c {command}'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'skill-nix-packages'

/** The seams this plugin registers into. */
export const inject = ['skills', 'commands']

/** Plugin config. */
export interface Config {
  /** Absolute skill roots scanned one level deep for `<name>/SKILL.md`. */
  roots?: string[]
  /** Wrapper command template. */
  wrapper?: string
}

const BaseConfig = z.object({
  roots: z.array(z.string()),
  wrapper: z.string(),
})

/** Register the nix-aware skill provider and the `/nix-skills` command. */
function activate(ctx: Context, config: Config): void {
  const wrapperTemplate = config.wrapper ?? DEFAULT_WRAPPER_TEMPLATE
  ctx.skills.registerProvider(
    () =>
      new NixSkillProvider({
        roots: config.roots ?? [],
        rank: 350,
        wrapperTemplate,
      }),
  )

  ctx.commands.register({
    name: 'nix-skills',
    description: 'Show the Nix package wrapper pattern or one skill declaration',
    input: { hint: '[SKILL]' },
    handler: async (invocation): Promise<CommandResult> => {
      const skill = invocation.rawInput.trim()
      if (skill.length === 0) {
        return {
          kind: 'success',
          text:
            `Nix package wrapper pattern: ${wrapperTemplate}\n` +
            'Skills declare packages under the metadata.nix-packages frontmatter key.',
        }
      }
      const found = await ctx.skills.get(skill)
      if (found === undefined) {
        return { kind: 'error', text: `Skill ${skill} was not found.` }
      }
      const packages = nixPackagesOf({
        name: found.name,
        description: found.description,
        metadata: found.metadata ?? {},
        content: found.content,
      })
      if (packages.length === 0) {
        return { kind: 'error', text: `Skill ${skill} declares no Nix packages.` }
      }
      return {
        kind: 'success',
        text:
          `Skill ${skill} declares Nix packages: ${packages.join(', ')}\n` +
          `Wrapper: ${expandWrapper(wrapperTemplate, packages, 'COMMAND')}`,
      }
    },
  })
}

/** Complete configuration and managed capability lifetime. */
export const Config = editableConfig(BaseConfig)
export const apply = managedApply(BaseConfig, activate)
