/**
 * Model equivalence groups: parse, serialize, transitive merge, and cycle
 * semantics. Pure domain.
 *
 * @module @loncothad/dsh-command-model-links/groups
 */

/** One equivalence group: model identifiers treated as the same model. */
export type ModelGroup = readonly string[]

/** Parse a `model=model[=model...]` semicolon-joined link table. */
export function parseLinkTable(value: string | undefined): ModelGroup[] {
  if (value === undefined || value.trim().length === 0) return []
  const groups: string[][] = []
  for (const rawGroup of value.split(';')) {
    const members: string[] = []
    for (const raw of rawGroup.split('=')) {
      const trimmed = raw.trim()
      if (trimmed.length > 0 && !members.includes(trimmed)) members.push(trimmed)
    }
    if (members.length >= 2) groups.push([...new Set(members)])
  }
  return groups
}

/** Serialize groups back into the `model=model` semicolon-joined form. */
export function serializeLinkTable(groups: readonly ModelGroup[]): string {
  return groups.map((group) => [...new Set(group)].join('=')).join(';')
}

/** Merge one new group into the table, fusing every group it touches. */
export function mergeGroup(
  groups: readonly ModelGroup[],
  members: readonly string[],
): ModelGroup[] {
  const unique = [...new Set(members)],
    connected = new Set(unique),
    included = new Set<number>()
  let changed = true
  while (changed) {
    changed = false
    groups.forEach((group, index) => {
      if (!included.has(index) && group.some((member) => connected.has(member))) {
        included.add(index)
        for (const member of group) connected.add(member)
        changed = true
      }
    })
  }
  const fused = [
    ...new Set([...groups.filter((_, index) => included.has(index)).flat(), ...unique]),
  ]
  const untouched = groups.filter((_, index) => !included.has(index))
  return fused.length >= 2 ? [fused, ...untouched] : untouched
}

/** Remove one model from its group; leftovers under two members dissolve. */
export function unlinkModel(
  groups: readonly ModelGroup[],
  model: string,
): { groups: ModelGroup[]; removed: boolean } {
  let removed = false
  const next: ModelGroup[] = []
  for (const group of groups) {
    if (!group.includes(model)) {
      next.push(group)
      continue
    }
    removed = true
    const rest = group.filter((member) => member !== model)
    if (rest.length >= 2) next.push(rest)
  }
  return { groups: next, removed }
}

/** The group containing one model, when linked. */
export function groupFor(groups: readonly ModelGroup[], model: string): ModelGroup | undefined {
  return groups.find((group) => group.includes(model))
}

/** The next model in `model`'s group, wrapping around; unlinked → undefined. */
export function nextModel(groups: readonly ModelGroup[], model: string): string | undefined {
  const group = groupFor(groups, model)
  if (group === undefined) return undefined
  const position = group.indexOf(model)
  return group[(position + 1) % group.length]!
}
