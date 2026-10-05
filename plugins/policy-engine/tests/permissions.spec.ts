import { fingerprint } from '@loncothad/dsh-execution-core'
import { expect, it } from 'vitest'
import { type Grant, inspectionCommands, matchesGrant, similarity } from '../src/permissions.ts'

const scope = {
    sessionId: 'chat',
    environment: 'dev',
    workspace: '/workspace',
    mode: 'workspace-write',
    boundary: 'dev',
  },
  policyHash = fingerprint('policy')
it('groups only literal workspace directory metadata, never shell prefixes or executable reads', () => {
  for (const command of ['pwd; ls -la', 'ls -lh', 'pwd -P', 'ls'])
    expect(inspectionCommands(command), command).toBe(true)
  for (const command of [
    'pwd;ls /etc',
    'ls -R',
    'git status',
    'cat .env',
    'ls $(whoami)',
    'ls; curl host',
    'ls | head',
    'ls > file',
    'ls && pwd',
    'ls\npwd',
    'ls *.ts',
    'ls `id`',
    'ENV=1 ls',
    'ls;',
    'ls -L',
    'ls /workspace',
  ])
    expect(inspectionCommands(command), command).toBe(false)
  expect(similarity('bash', { command: 'pwd; ls -la' }, scope, policyHash)?.signature).toBe(
    similarity('bash', { command: 'ls -lh', description: 'Inspect files' }, scope, policyHash)
      ?.signature,
  )
  expect(
    similarity('bash', { command: 'ls', workdir: '/other' }, scope, policyHash)?.signature,
  ).not.toBe(similarity('bash', { command: 'ls' }, scope, policyHash)?.signature)
  expect(
    similarity(
      'bash',
      { command: 'ls', sandbox_permissions: 'require_escalated' },
      scope,
      policyHash,
    ),
  ).toBeUndefined()
})
it('binds remembered actions to exact arguments, policy, chat, workspace, environment and sandbox mode', () => {
  const candidate = similarity('publish', { target: 'staging' }, scope, policyHash)!
  const grant: Grant = {
    ...candidate,
    id: candidate.signature,
    policyHash,
    sessionId: scope.sessionId,
    environment: scope.environment,
    mode: scope.mode,
    expiresAt: 200,
    createdAt: 0,
  }
  const review = { effect: 'require_review' as const, requestHash: 'action', ruleIds: [] }
  expect(matchesGrant(grant, candidate, scope, policyHash, review, 100)).toBe(true)
  for (const change of [
    { sessionId: 'fork' },
    { workspace: '/other' },
    { environment: 'prod' },
    { mode: 'full-access' },
    { boundary: 'another' },
  ]) {
    const next = { ...scope, ...change }
    expect(
      matchesGrant(
        grant,
        similarity('publish', { target: 'staging' }, next, policyHash)!,
        next,
        policyHash,
        review,
        100,
      ),
    ).toBe(false)
  }
  expect(
    matchesGrant(
      grant,
      similarity('publish', { target: 'prod' }, scope, policyHash)!,
      scope,
      policyHash,
      review,
      100,
    ),
  ).toBe(false)
  expect(matchesGrant(grant, candidate, scope, fingerprint('new-policy'), review, 100)).toBe(false)
  expect(matchesGrant(grant, candidate, scope, policyHash, review, 201)).toBe(false)
  expect(
    matchesGrant(grant, candidate, scope, policyHash, { ...review, effect: 'deny' }, 100),
  ).toBe(false)
})
