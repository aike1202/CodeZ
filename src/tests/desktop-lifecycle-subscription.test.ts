import { describe, expect, it, vi } from 'vitest'

import type {
  AgentRuntimeSnapshot,
  AgentUpdatedEvent,
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

function agentSnapshot(sessionId: string, revision: number): AgentRuntimeSnapshot {
  return { version: 1, sessionId, revision, agents: [], messages: [] }
}

function todoEvent(sessionId: string, revision: number): TodoUpdatedEvent {
  return { version: 1, sessionId, revision, snapshot: todoSnapshot(sessionId, revision) }
}

function agentEvent(sessionId: string, revision: number): AgentUpdatedEvent {
  return { version: 1, sessionId, revision, snapshot: agentSnapshot(sessionId, revision) }
}

function acceptingSink(): DesktopLifecycleSink {
  return {
    todoEvent: vi.fn(() => 'applied'),
    todoSnapshot: vi.fn(() => 'applied'),
    agentEvent: vi.fn(() => 'applied'),
    agentSnapshot: vi.fn(() => 'applied')
  }
}

describe('desktop lifecycle subscription controller', () => {
  it('registers both listeners before loading the initial snapshots', async () => {
    const order: string[] = []
    const source: DesktopLifecycleSource = {
      todoSnapshot: vi.fn(async (sessionId) => {
        order.push('todo-snapshot')
        return todoSnapshot(sessionId, 0)
      }),
      agentSnapshot: vi.fn(async (sessionId) => {
        order.push('agent-snapshot')
        return agentSnapshot(sessionId, 0)
      }),
      onTodoUpdated: vi.fn(async () => {
        order.push('todo-listen')
        return () => undefined
      }),
      onAgentUpdated: vi.fn(async () => {
        order.push('agent-listen')
        return () => undefined
      })
    }

    const cleanup = startDesktopLifecycleSubscription('session-1', source, acceptingSink())
    await vi.waitFor(() => expect(order).toHaveLength(4))
    cleanup()

    expect(order.slice(0, 2).sort()).toEqual(['agent-listen', 'todo-listen'])
    expect(order.slice(2).sort()).toEqual(['agent-snapshot', 'todo-snapshot'])
  })

  it('deduplicates a Todo gap refresh for the event session', async () => {
    let onTodoUpdated: ((event: TodoUpdatedEvent) => void) | undefined
    let onAgentUpdated: ((event: AgentUpdatedEvent) => void) | undefined
    const source: DesktopLifecycleSource = {
      todoSnapshot: vi.fn(async (sessionId) => todoSnapshot(sessionId, 4)),
      agentSnapshot: vi.fn(async (sessionId) => agentSnapshot(sessionId, 1)),
      onTodoUpdated: vi.fn(async (callback) => {
        onTodoUpdated = callback
        return () => undefined
      }),
      onAgentUpdated: vi.fn(async (callback) => {
        onAgentUpdated = callback
        return () => undefined
      })
    }
    const sink = acceptingSink()
    vi.mocked(sink.todoEvent).mockReturnValue('gap')

    const cleanup = startDesktopLifecycleSubscription('session-1', source, sink)
    await vi.waitFor(() => expect(source.todoSnapshot).toHaveBeenCalledWith('session-1'))
    onTodoUpdated?.(todoEvent('session-background', 4))
    onTodoUpdated?.(todoEvent('session-background', 4))
    onAgentUpdated?.(agentEvent('session-background', 1))
    await vi.waitFor(() => expect(source.todoSnapshot).toHaveBeenCalledTimes(2))
    cleanup()

    expect(source.todoSnapshot).toHaveBeenLastCalledWith('session-background')
    expect(sink.agentEvent).toHaveBeenCalledOnce()
  })

  it('unlistens after an early unmount and ignores callbacks from the previous session', async () => {
    const callbacks: Array<(event: TodoUpdatedEvent) => void> = []
    const todoUnlisten = vi.fn()
    const agentUnlisten = vi.fn()
    let resolveTodoListener: ((unlisten: () => void) => void) | undefined
    let resolveAgentListener: ((unlisten: () => void) => void) | undefined
    const source: DesktopLifecycleSource = {
      todoSnapshot: vi.fn(async (sessionId) => todoSnapshot(sessionId, 0)),
      agentSnapshot: vi.fn(async (sessionId) => agentSnapshot(sessionId, 0)),
      onTodoUpdated: vi.fn((callback) => {
        callbacks.push(callback)
        return new Promise((resolve) => { resolveTodoListener = resolve })
      }),
      onAgentUpdated: vi.fn(() => {
        return new Promise((resolve) => { resolveAgentListener = resolve })
      })
    }
    const sink = acceptingSink()

    const cleanupFirst = startDesktopLifecycleSubscription('session-1', source, sink)
    cleanupFirst()
    resolveTodoListener?.(todoUnlisten)
    resolveAgentListener?.(agentUnlisten)
    await vi.waitFor(() => expect(todoUnlisten).toHaveBeenCalledOnce())
    expect(agentUnlisten).toHaveBeenCalledOnce()
    expect(source.todoSnapshot).not.toHaveBeenCalled()

    vi.mocked(source.onTodoUpdated).mockImplementationOnce(async (callback) => {
      callbacks.push(callback)
      return todoUnlisten
    })
    vi.mocked(source.onAgentUpdated).mockResolvedValueOnce(agentUnlisten)
    const cleanupSecond = startDesktopLifecycleSubscription('session-2', source, sink)
    await vi.waitFor(() => expect(source.todoSnapshot).toHaveBeenCalledWith('session-2'))
    callbacks[0](todoEvent('session-1', 1))
    callbacks[1](todoEvent('session-2', 1))
    cleanupSecond()

    expect(sink.todoEvent).toHaveBeenCalledOnce()
    expect(sink.todoEvent).toHaveBeenCalledWith(todoSnapshot('session-2', 1))
  })
})
