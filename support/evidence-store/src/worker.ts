import { parentPort, workerData } from 'node:worker_threads'
import { SqliteEvidenceStore } from './store.ts'
import type { StoreCommand } from './types.ts'

if (!parentPort) throw new Error('Evidence storage must run in a worker')
const store = new SqliteEvidenceStore(workerData.path as string, workerData.workspaceId as string)
parentPort.on('message', ({ id, command }: { id: number; command: StoreCommand }) => {
  try {
    const result =
      command.op === 'capture'
        ? store.capture(command.scope, command.event)
        : command.op === 'search'
          ? store.search(command.scope, command.query, command.limit)
          : command.op === 'read'
            ? store.read(command.scope, command.ids)
            : command.op === 'delete'
              ? store.delete(command.scope, command.eventId)
              : command.op === 'deleted'
                ? store.deleted(command.scope, command.eventIds)
                : command.op === 'manifest-available'
                  ? store.stateStore.manifestAvailable(command.scope, command.id)
                  : command.op === 'retire'
                    ? store.retire(command.before, command.protectedSessions, command.limit)
                    : command.op === 'state'
                      ? store.stateStore.state(command.scope)
                      : command.op === 'seal'
                        ? store.stateStore.seal(command.scope, command.group)
                        : command.op === 'controls'
                          ? store.stateStore.controls(
                              command.scope,
                              command.expectedRevision,
                              command.records,
                            )
                          : command.op === 'read-controls'
                            ? store.stateStore.readControls(command.scope, command.revision)
                            : command.op === 'policy'
                              ? store.stateStore.policy(command.scope, command.policy)
                              : command.op === 'pending'
                                ? store.stateStore.pending(command.scope, command.limit)
                                : command.op === 'enqueue'
                                  ? store.stateStore.enqueue(
                                      command.scope,
                                      command.evidenceIds,
                                      command.sourceTokens,
                                    )
                                  : command.op === 'claim'
                                    ? store.stateStore.claim(command.scope)
                                    : command.op === 'diagnostics'
                                      ? store.stateStore.diagnostics(command.scope)
                                      : command.op === 'publish'
                                        ? store.stateStore.publish(
                                            command.scope,
                                            command.job,
                                            command.payload,
                                            command.report,
                                          )
                                        : command.op === 'gap'
                                          ? store.stateStore.gap(
                                              command.scope,
                                              command.job,
                                              command.report,
                                              command.retry,
                                            )
                                          : command.op === 'atoms'
                                            ? store.stateStore.atoms(command.scope, command.limit)
                                            : command.op === 'manifest'
                                              ? store.stateStore.manifest(
                                                  command.scope,
                                                  command.input,
                                                )
                                              : command.op === 'replay'
                                                ? store.stateStore.replay(command.scope, command.id)
                                                : command.op === 'replay-request'
                                                  ? store.stateStore.replayRequest(
                                                      command.scope,
                                                      command.id,
                                                    )
                                                  : command.op === 'cleanup-orphans'
                                                    ? store.cleanupOrphans(
                                                        command.now,
                                                        command.limit,
                                                      )
                                                    : command.op === 'cold'
                                                      ? store.coldCandidates(
                                                          command.now,
                                                          command.limit,
                                                        )
                                                      : command.op === 'compressed'
                                                        ? store.publishCompressed(
                                                            command.candidate,
                                                            command.encoded,
                                                          )
                                                        : command.op === 'status'
                                                          ? store.status()
                                                          : store.close()
    parentPort!.postMessage({ id, result })
    if (command.op === 'close') parentPort!.close()
  } catch (error) {
    parentPort!.postMessage({
      id,
      error: error instanceof Error ? error.message : 'Evidence storage operation failed',
    })
  }
})
