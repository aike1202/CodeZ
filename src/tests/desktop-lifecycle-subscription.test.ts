import { describe, expect, it, vi } from 'vitest'

import type {
  AgentRuntimeSnapshot,
  AgentUpdatedEvent,
  TodoListSnapshot as TaskSnapshot,
  TodoUpdatedEvent as TaskUpdatedEvent
} from '../renderer/src/shared/desktop/generated/contracts'
import {
  startDesktopLifecycleSubscription,
  type DesktopLifecycleSink,
  type DesktopLifecycleSource
} from '../renderer/src/components/chat/hooks/useDesktopLifecycleSubscription'

function taskSnapshot(sessionId: string, revision: number): TaskSnapshot {
  return { version: 1, sessionId, revision, nextSequence: 1, items: [] }
}

function agentSnapshot(sessionId: string, revision: number): AgentRuntimeSnapshot {
  return { version: 1, sessionId, revision, agents: [], messages: [] }
}

function taskEvent(sessionId: string, revision: number): TaskUpdatedEvent {
  return { version: 1, sessionId, revision, snapshot: taskSnapshot(sessionId, revision) }
}

function agentEvent(sessionId: string, revision: number): AgentUpdatedEvent {
  return { version: 1, sessionId, revision, snapshot: agentSnapshot(sessionId, revision) }
}

function acceptingSink(): DesktopLifecycleSink {
  return {
    taskEvent: vi.fn(() => 'applied'),
    taskSnapshot: vi.fn(() => 'applied'),
    agentEvent: vi.fn(() => 'applied'),
    agentSnapshot: vi.fn(() => 'applied')
  }
}

describe('desktop lifecycle subscription controller', () => {
  it('registers both listeners before loading the initial snapshots', async () => {
    const order: string[] = []
    const source: DesktopLifecycleSource = {
      taskSnapshot: vi.fn(async (sessionId) => {
        order.push('task-snapshot')
        return taskSnapshot(sessionId, 0)
      }),
      agentSnapshot: vi.fn(async (sessionId) => {
        order.push('agent-snapshot')
        return agentSnapshot(sessionId, 0)
      }),
      onTaskUpdated: vi.fn(async () => {
        order.push('task-listen')
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

    expect(order.slice(0, 2).sort()).toEqual(['agent-listen', 'task-listen'])
    expect(order.slice(2).sort()).toEqual(['agent-snapshot', 'task-snapshot'])
  })

  it('deduplicates a Task gap refresh for the event session', async () => {
    let onTaskUpdated: ((event: TaskUpdatedEvent) => void) | undefined
    let onAgentUpdated: ((event: AgentUpdatedEvent) => void) | undefined
    const source: DesktopLifecycleSource = {
      taskSnapshot: vi.fn(async (sessionId) => taskSnapshot(sessionId, 4)),
      agentSnapshot: vi.fn(async (sessionId) => agentSnapshot(sessionId, 1)),
      onTaskUpdated: vi.fn(async (callback) => {
        onTaskUpdated = callback
        return () => undefined
      }),
      onAgentUpdated: vi.fn(async (callback) => {
        onAgentUpdated = callback
        return () => undefined
      })
    }
    const sink = acceptingSink()
    vi.mocked(sink.taskEvent).mockReturnValue('gap')

    const cleanup = startDesktopLifecycleSubscription('session-1', source, sink)
    await vi.waitFor(() => expect(source.taskSnapshot).toHaveBeenCalledWith('session-1'))
    onTaskUpdated?.(taskEvent('session-background', 4))
    onTaskUpdated?.(taskEvent('session-background', 4))
    onAgentUpdated?.(agentEvent('session-background', 1))
    await vi.waitFor(() => expect(source.taskSnapshot).toHaveBeenCalledTimes(2))
    cleanup()

    expect(source.taskSnapshot).toHaveBeenLastCalledWith('session-background')
    expect(sink.agentEvent).toHaveBeenCalledOnce()
  })

  it('unlistens after an early unmount and ignores callbacks from the previous session', async () => {
    const callbacks: Array<(event: TaskUpdatedEvent) => void> = []
    const taskUnlisten = vi.fn()
    const agentUnlisten = vi.fn()
    let resolveTaskListener: ((unlisten: () => void) => void) | undefined
    let resolveAgentListener: ((unlisten: () => void) => void) | undefined
    const source: DesktopLifecycleSource = {
      taskSnapshot: vi.fn(async (sessionId) => taskSnapshot(sessionId, 0)),
      agentSnapshot: vi.fn(async (sessionId) => agentSnapshot(sessionId, 0)),
      onTaskUpdated: vi.fn((callback) => {
        callbacks.push(callback)
        return new Promise((resolve) => { resolveTaskListener = resolve })
      }),
      onAgentUpdated: vi.fn(() => {
        return new Promise((resolve) => { resolveAgentListener = resolve })
      })
    }
    const sink = acceptingSink()

    const cleanupFirst = startDesktopLifecycleSubscription('session-1', source, sink)
    cleanupFirst()
    resolveTaskListener?.(taskUnlisten)
    resolveAgentListener?.(agentUnlisten)
    await vi.waitFor(() => expect(taskUnlisten).toHaveBeenCalledOnce())
    expect(agentUnlisten).toHaveBeenCalledOnce()
    expect(source.taskSnapshot).not.toHaveBeenCalled()

    vi.mocked(source.onTaskUpdated).mockImplementationOnce(async (callback) => {
      callbacks.push(callback)
      return taskUnlisten
    })
    vi.mocked(source.onAgentUpdated).mockResolvedValueOnce(agentUnlisten)
    const cleanupSecond = startDesktopLifecycleSubscription('session-2', source, sink)
    await vi.waitFor(() => expect(source.taskSnapshot).toHaveBeenCalledWith('session-2'))
    callbacks[0](taskEvent('session-1', 1))
    callbacks[1](taskEvent('session-2', 1))
    cleanupSecond()

    expect(sink.taskEvent).toHaveBeenCalledOnce()
    expect(sink.taskEvent).toHaveBeenCalledWith(taskSnapshot('session-2', 1))
  })
})
