# Nix Package Skills reference

A `SkillProvider` that scans configured roots for `<name>/SKILL.md`,
surfaces `metadata.nix-packages` declarations on skill candidates, and
appends the exact configured `nix shell` wrapper instruction to loaded
package-declaring skills. No hardcoded paths: the wrapper template is
config (`nix shell {packages} -c {command}` by default).
