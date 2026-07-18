import { describe, expect, it, vi } from 'vitest'
import type {
  TodoListSnapshot,
  TodoUpdatedEvent
} from '../renderer/src/shared/desktop/generated/contracts'
import {
  startDesktopLifecycleSubscription,
  type DesktopLifecycleSink,
  type DesktopLifecycleSource
} from '../renderer/src/components/chat/hooks/useDesktopLifecycleSubscription'

function todoSnapshot(sessionId: string, revision: number): TodoListSnapshot {
  return { version: 2, sessionId, revision, nextSequence: 1, items: [], archivedItems: [] }
}

function todoEvent(sessionId: string, revision: number): TodoUpdatedEvent {
  return { version: 1, sessionId, revision, snapshot: todoSnapshot(sessionId, revision) }
}

function acceptingSink(): DesktopLifecycleSink {
  return {
    todoEvent: vi.fn(() => 'applied'),
    todoSnapshot: vi.fn(() => 'applied')
  }
}

describe('desktop lifecycle subscription controller', () => {
  it('registers the listener before loading the initial snapshot', async () => {
    const order: string[] = []
    const source: DesktopLifecycleSource = {
      todoSnapshot: vi.fn(async (sessionId) => {
        order.push('todo-snapshot')
        return todoSnapshot(sessionId, 0)
      }),
      onTodoUpdated: vi.fn(async () => {
        order.push('todo-listen')
        return () => undefined
      })
    }

    const cleanup = startDesktopLifecycleSubscription('session-1', source, acceptingSink())
    await vi.waitFor(() => expect(order).toHaveLength(2))
    cleanup()

    expect(order).toEqual(['todo-listen', 'todo-snapshot'])
  })

  it('deduplicates a Todo gap refresh for the event session', async () => {
    let onTodoUpdated: ((event: TodoUpdatedEvent) => void) | undefined
    const source: DesktopLifecycleSource = {
      todoSnapshot: vi.fn(async (sessionId) => todoSnapshot(sessionId, 4)),
      onTodoUpdated: vi.fn(async (callback) => {
        onTodoUpdated = callback
        return () => undefined
      })
    }
    const sink = acceptingSink()
    vi.mocked(sink.todoEvent).mockReturnValue('gap')

    const cleanup = startDesktopLifecycleSubscription('session-1', source, sink)
    await vi.waitFor(() => expect(source.todoSnapshot).toHaveBeenCalledWith('session-1'))
    onTodoUpdated?.(todoEvent('session-background', 4))
    onTodoUpdated?.(todoEvent('session-background', 4))
    await vi.waitFor(() => expect(source.todoSnapshot).toHaveBeenCalledTimes(2))
    cleanup()

    expect(source.todoSnapshot).toHaveBeenLastCalledWith('session-background')
  })

  it('unlistens after an early unmount', async () => {
    const unlisten = vi.fn()
    let resolveListener: ((dispose: () => void) => void) | undefined
    const source: DesktopLifecycleSource = {
      todoSnapshot: vi.fn(async (sessionId) => todoSnapshot(sessionId, 0)),
      onTodoUpdated: vi.fn(() => new Promise((resolve) => { resolveListener = resolve }))
    }

    const cleanup = startDesktopLifecycleSubscription('session-1', source, acceptingSink())
    cleanup()
    resolveListener?.(unlisten)
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce())
    expect(source.todoSnapshot).not.toHaveBeenCalled()
  })
})
