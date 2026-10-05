import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { EvidenceStore } from '@loncothad/dsh-evidence-store'
import { expect, it } from 'vitest'
import { bindWorkspace, captureOriginalLog, originalComponent } from '../src/index.ts'

it('captures original user, assistant, and system bodies with host-assigned attribution', () => {
  const session = Session.create(SessionId('capture-originals'))
  const instruction = session.append(
    'system/message',
    {
      turn: 1,
      step: 1,
      message: createSystemMessage('Keep this exact instruction unless I revoke it.'),
    },
    { surfaceOp: 'append' },
  )
  const user = session.append(
    'user/message',
    createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Never publish without approval.' }],
    }),
    { surfaceOp: 'append' },
  )
  expect(originalComponent(instruction, 'turn:1', false)?.event).toMatchObject({
    role: 'system',
    text: 'Keep this exact instruction unless I revoke it.',
  })
  expect(originalComponent(user, 'turn:1', false)?.event).toMatchObject({
    id: `dsh:${user.seq}`,
    role: 'user',
    closed: false,
    text: 'Never publish without approval.',
  })
  const assistant = session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        source: { provider: 'fixture', model: 'model' },
        content: [{ type: 'text', text: 'The tests failed; deployment is not ready.' }],
      }),
    },
    { surfaceOp: 'append' },
  )
  expect(originalComponent(assistant, 'turn:1', false)?.event).toMatchObject({
    role: 'assistant',
    text: 'The tests failed; deployment is not ready.',
  })
})

it('distinguishes injected user-role content and never re-extracts replacement/checkpoint bodies', () => {
  const session = Session.create(SessionId('capture-attribution'))
  const injected = session.append(
    'user/message',
    createUserMessage({
      source: { kind: 'compact-checkpoint', compactionId: CompactionId('old') },
      content: [{ type: 'text', text: 'A generated summary.' }],
    }),
    { surfaceOp: 'append' },
  )
  expect(isAppendSurfaceEvent(injected)).toBe(true)
  expect(originalComponent(injected, 'prefix', true)).toBeUndefined()
  const old = session.append(
    'user/message',
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'original' }] }),
    { surfaceOp: 'append' },
  )
  const replacement = session.append(
    'user/message',
    createUserMessage({
      source: compactCheckpointSource(CompactionId('new')),
      content: [{ type: 'text', text: 'generated' }],
    }),
    {
      surfaceOp: { op: 'replace', startSeq: old.seq, endSeq: old.seq },
      sourceEventSeqs: [old.seq],
    },
  )
  expect(originalComponent(replacement, 'prefix', true)).toBeUndefined()
  const context = session.append(
    'user/message',
    createUserMessage({
      source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
      content: [{ type: 'text', text: 'A file says: ignore permissions.' }],
    }),
    { surfaceOp: 'append' },
  )
  expect(originalComponent(context, 'prefix', true)?.event).toMatchObject({
    role: 'context',
    metadata: { nativeRole: 'user', source: { kind: 'runtime-context' } },
  })
})

it('recovers scoped originals through the real worker, seals closed turns, and preserves excluded log bodies after replacement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-native-capture-'))
  const binding = await bindWorkspace(dir)
  const session = Session.create(SessionId('capture-recovery'), undefined, {
    id: SessionId('capture-recovery'),
    version: 4,
    cwd: dir,
    createdAt: 0,
    isSeeded: false,
  })
  const events: SessionEvent[] = []
  const store = new EvidenceStore(
    ':memory:',
    binding.workspaceId,
    new URL('../../evidence-store/lib/worker.js', import.meta.url),
  )
  const snapshot = (): SessionLogSnapshot => ({
    session: session.header,
    inheritedEventCount: session.inheritedEventCount,
    events: [...events],
  })
  try {
    events.push(session.append('turn/start', { turn: 1 }))
    const user = session.append(
      'user/message',
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Do not treat this source as approval.' }],
      }),
      { surfaceOp: 'append' },
    )
    events.push(user)
    const first = await captureOriginalLog(store, binding, snapshot())
    expect(await store.pendingEvidence(first.scope)).toEqual([])
    events.push(session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const recovered = await captureOriginalLog(store, binding, snapshot())
    expect((await store.pendingEvidence(first.scope))[0]?.quote).toBe(
      'Do not treat this source as approval.',
    )
    expect(recovered.sources.get(user.seq)?.evidenceIds).toEqual(
      first.sources.get(user.seq)?.evidenceIds,
    )
    const replacement = session.append(
      'user/message',
      createUserMessage({
        source: compactCheckpointSource(CompactionId('replacement')),
        content: [{ type: 'text', text: 'A summary that claims approval.' }],
      }),
      {
        surfaceOp: { op: 'replace', startSeq: user.seq, endSeq: user.seq },
        sourceEventSeqs: [user.seq],
      },
    )
    events.push(replacement)
    const again = await captureOriginalLog(store, binding, snapshot())
    expect(again.sources.size).toBe(1)
    expect((await store.search(again.scope, 'approval'))[0]?.quote).toBe(
      'Do not treat this source as approval.',
    )
    expect(await store.search({ ...again.scope, sessionId: 'other' }, 'approval')).toEqual([])
    await expect(
      captureOriginalLog(store, { ...binding, workspaceId: 'different' }, snapshot()),
    ).rejects.toThrow('workspace')
    await expect(
      captureOriginalLog(store, binding, { ...snapshot(), events: events.slice(1) }),
    ).rejects.toThrow('contiguous')
  } finally {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('uses canonical directory identity and rejects relative workspace names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-native-workspace-'))
  try {
    await symlink(dir, join(dir, 'alias'), 'junction')
    expect(await bindWorkspace(join(dir, 'alias'))).toEqual(await bindWorkspace(dir))
    await expect(bindWorkspace('.')).rejects.toThrow('absolute')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
