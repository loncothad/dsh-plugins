import type { Context, Fiber, Volatile } from '@deepseek-ai/cordis'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
export interface ShellBudgets {
  cwd?: string
  timeoutMs?: number
  maxTimeoutMs?: number
  maxOutputBytes?: number
  maxSpillBytes?: number
  graceMs?: number
}
export interface ShellRule {
  id: string
  priority: number
  budgets: ShellBudgets
  resolve(
    workdir: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<{ root: string; command: string } | undefined>
}
interface Member {
  rule: ShellRule
  lifetime: AbortController
}
interface Routing {
  rules: Map<string, Member>
  fiber: Fiber
  closing?: Promise<void>
}
const roots = new WeakMap<Context, Routing>()
const reference = <T>(get: () => T): Volatile<T> => ({ get: get as () => never })
export class ProjectShellExecutor extends SandboxBashExecutor {
  constructor(
    ctx: Context,
    private readonly rules: Map<string, Member>,
  ) {
    const bounded = (key: Exclude<keyof ShellBudgets, 'cwd'>, fallback: number) =>
      reference(() =>
        rules.size
          ? Math.min(...[...rules.values()].map((member) => member.rule.budgets[key] ?? fallback))
          : fallback,
      )
    super(ctx, {
      cwd: reference(
        () => [...rules.values()].find((member) => member.rule.budgets.cwd)?.rule.budgets.cwd,
      ),
      timeoutMs: bounded('timeoutMs', 120000),
      maxTimeoutMs: bounded('maxTimeoutMs', 600000),
      maxOutputBytes: bounded('maxOutputBytes', 64000),
      maxSpillBytes: bounded('maxSpillBytes', 67108864),
      graceMs: bounded('graceMs', 3000),
    })
  }
  async route(
    workdir: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<{ command: string; signal?: AbortSignal }> {
    const candidates: { member: Member; root: string; command: string }[] = []
    for (const member of this.rules.values()) {
      signal?.throwIfAborted()
      const result = await member.rule.resolve(workdir, command, signal)
      if (result) candidates.push({ member, ...result })
    }
    candidates.sort(
      (a, b) => b.root.length - a.root.length || b.member.rule.priority - a.member.rule.priority,
    )
    const selected = candidates[0]
    return selected
      ? {
          command: selected.command,
          signal: AbortSignal.any([
            signal ?? new AbortController().signal,
            selected.member.lifetime.signal,
          ]),
        }
      : { command, signal }
  }
  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const selected = await this.route(spec.workdir, spec.command, spec.signal)
    return super.execute({ ...spec, ...selected })
  }
}
export async function registerShellRule(ctx: Context, rule: ShellRule): Promise<void> {
  const root = ctx.root
  let routing = roots.get(root)
  if (routing?.closing) {
    await routing.closing
    routing = roots.get(root)
  }
  if (!routing) {
    const rules = new Map<string, Member>()
    routing = {
      rules,
      fiber: root.plugin({
        inject: SandboxBashExecutor.inject,
        apply(scope: Context) {
          new ProjectShellExecutor(scope, rules)
        },
      }),
    }
    roots.set(root, routing)
  }
  if (routing.rules.has(rule.id)) throw new Error(`Shell rule already registered: ${rule.id}`)
  if (
    rule.budgets.cwd &&
    [...routing.rules.values()].some(
      (member) => member.rule.budgets.cwd && member.rule.budgets.cwd !== rule.budgets.cwd,
    )
  )
    throw new Error('Shell plugins must share the same default directory, or leave it unset')
  const member = { rule, lifetime: new AbortController() }
  routing.rules.set(rule.id, member)
  ctx.effect(
    () => async () => {
      member.lifetime.abort(new Error('Shell rule was replaced'))
      routing.rules.delete(rule.id)
      if (!routing.rules.size) {
        routing.closing = routing.fiber.dispose().then(() => {
          if (roots.get(root) === routing) roots.delete(root)
        })
        await routing.closing
      }
    },
    `shell routing: own ${rule.id}`,
  )
  await routing.fiber.await()
}
