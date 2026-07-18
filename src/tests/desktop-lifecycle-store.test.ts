import { beforeEach, describe, expect, it } from 'vitest'
import type { TodoListSnapshot } from '../renderer/src/shared/desktop/generated/contracts'
import { useDesktopLifecycleStore } from '../renderer/src/stores/desktopLifecycleStore'

function todoSnapshot(sessionId: string, revision: number, todoId = `todo-${revision}`): TodoListSnapshot {
  return {
    version: 2,
    sessionId,
    revision,
    nextSequence: revision + 1,
    items: [{
      id: todoId,
      subject: 'Verify lifecycle',
      description: '',
      status: 'pending',
      requiresApproval: false,
      approvalStatus: 'not_required'
    }],
    archivedItems: []
  }
}

describe('desktop lifecycle store', () => {
  beforeEach(() => useDesktopLifecycleStore.setState({ todoSnapshots: {} }))

  it('ignores old Todo revisions and refreshes across a gap', () => {
    const store = useDesktopLifecycleStore.getState()
    expect(store.applyTodoEvent(todoSnapshot('session-1', 1))).toBe('applied')
    expect(store.applyTodoEvent(todoSnapshot('session-1', 1, 'duplicate'))).toBe('ignored')
    expect(store.applyTodoEvent(todoSnapshot('session-1', 3))).toBe('gap')
    expect(store.applyTodoSnapshot(todoSnapshot('session-1', 3))).toBe('applied')
    expect(useDesktopLifecycleStore.getState().todoSnapshots['session-1']?.revision).toBe(3)
  })

  it('keeps Todo revisions isolated by session', () => {
    const store = useDesktopLifecycleStore.getState()
    expect(store.applyTodoEvent(todoSnapshot('session-a', 1))).toBe('applied')
    expect(store.applyTodoEvent(todoSnapshot('session-b', 1))).toBe('applied')
    expect(useDesktopLifecycleStore.getState().todoSnapshots['session-a']?.items[0].id).toBe('todo-1')
    expect(useDesktopLifecycleStore.getState().todoSnapshots['session-b']?.items[0].id).toBe('todo-1')
  })
})
