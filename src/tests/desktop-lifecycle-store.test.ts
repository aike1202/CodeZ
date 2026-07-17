import { beforeEach, describe, expect, it } from 'vitest'

import type {
  AgentRuntimeSnapshot,
  TaskSnapshot
} from '../renderer/src/shared/desktop/generated/contracts'
import { useDesktopLifecycleStore } from '../renderer/src/stores/desktopLifecycleStore'

function taskSnapshot(sessionId: string, revision: number, taskId = `task-${revision}`): TaskSnapshot {
  return {
    version: 1,
    sessionId,
    revision,
    nextSequence: revision + 1,
    tasks: [{
      id: taskId,
      subject: 'Verify lifecycle',
      description: '',
      status: 'pending',
      requiresApproval: false,
      approvalStatus: 'not_required'
    }]
  }
}

function agentSnapshot(sessionId: string, revision: number): AgentRuntimeSnapshot {
  return { version: 1, sessionId, revision, agents: [], messages: [] }
}

describe('desktop lifecycle store', () => {
  beforeEach(() => {
    useDesktopLifecycleStore.setState({ taskSnapshots: {}, agentSnapshots: {} })
  })

  it('ignores duplicate and out-of-order task revisions and refreshes across a gap', () => {
    const store = useDesktopLifecycleStore.getState()

    expect(store.applyTaskEvent(taskSnapshot('session-1', 1))).toBe('applied')
    expect(store.applyTaskEvent(taskSnapshot('session-1', 1, 'duplicate'))).toBe('ignored')
    expect(store.applyTaskEvent(taskSnapshot('session-1', 0, 'older'))).toBe('ignored')
    expect(store.applyTaskEvent(taskSnapshot('session-1', 3))).toBe('gap')
    expect(store.applyTaskSnapshot(taskSnapshot('session-1', 3))).toBe('applied')
    expect(useDesktopLifecycleStore.getState().taskSnapshots['session-1']?.revision).toBe(3)
  })

  it('keeps task and Agent revisions isolated by session', () => {
    const store = useDesktopLifecycleStore.getState()

    expect(store.applyTaskEvent(taskSnapshot('session-a', 1))).toBe('applied')
    expect(store.applyTaskEvent(taskSnapshot('session-b', 1))).toBe('applied')
    expect(store.applyAgentEvent(agentSnapshot('session-a', 1))).toBe('applied')
    expect(store.applyAgentEvent(agentSnapshot('session-b', 2))).toBe('gap')
    expect(store.applyAgentSnapshot(agentSnapshot('session-b', 2))).toBe('applied')

    const next = useDesktopLifecycleStore.getState()
    expect(next.taskSnapshots['session-a']?.tasks[0].id).toBe('task-1')
    expect(next.taskSnapshots['session-b']?.tasks[0].id).toBe('task-1')
    expect(next.agentSnapshots['session-a']?.revision).toBe(1)
    expect(next.agentSnapshots['session-b']?.revision).toBe(2)
  })
})
