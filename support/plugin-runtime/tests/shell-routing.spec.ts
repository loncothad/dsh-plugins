import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, vi } from 'vitest'
import { registerShellRule } from '../src/shell-routing.ts'

it.runIf(process.platform !== 'win32')(
  'owns an injected sandbox executor, joins the last disposal, and can register again',
  async () => {
    const ctx = new Context(),
      confine = vi.fn(async (argv: string[]) => ({
        argv,
        enforcement: 'full',
        denialSignatures: [],
        runnerFailureRules: [],
      }))
    try {
      await ctx.plugin(LocalSubprocess)
      ctx.provide('sandbox', { confine } as never)
      ctx.provide('sandboxPolicy', {
        defaultMode: 'workspace-write',
        resolve: () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }),
      } as never)
      const rule = (id: string) => ({
        id,
        priority: 0,
        budgets: {},
        resolve: async () => undefined,
      })
      const first = ctx.plugin({
          apply: async (child: Context) => registerShellRule(child, rule('devenv')),
        }),
        second = ctx.plugin({
          apply: async (child: Context) => registerShellRule(child, rule('nix')),
        })
      await first.await()
      await second.await()
      const execute = async () => {
        const spec = ctx.shell.resolve({ command: 'pwd; ls -la', workdir: process.cwd() })
        return (await ctx.shell.execute(spec)).result()
      }
      expect((await execute()).exitCode).toBe(0)
      expect(confine).toHaveBeenCalledOnce()
      await first.dispose()
      expect((await execute()).exitCode).toBe(0)
      await second.dispose()
      expect(ctx.get('shell')).toBeUndefined()
      const replacement = ctx.plugin({
        apply: async (child: Context) => registerShellRule(child, rule('devenv')),
      })
      await replacement.await()
      expect((await execute()).exitCode).toBe(0)
      await replacement.dispose()
      expect(ctx.get('shell')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  },
  20000,
)
