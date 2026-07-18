import { useEffect } from 'react'

import { desktopApi, desktopEvents } from '../../../shared/desktop'
import type {
  AgentRuntimeSnapshot,
  AgentUpdatedEvent,
  TodoListSnapshot,
  TodoUpdatedEvent
} from '../../../shared/desktop/generated/contracts'
import { useChatStore } from '../../../stores/chatStore'
import {
  useDesktopLifecycleStore,
  type SnapshotApplyResult
} from '../../../stores/desktopLifecycleStore'

type Unlisten = () => void

export interface DesktopLifecycleSource {
  todoSnapshot(sessionId: string): Promise<TodoListSnapshot>
  agentSnapshot(sessionId: string): Promise<AgentRuntimeSnapshot>
  onTodoUpdated(callback: (event: TodoUpdatedEvent) => void): Promise<Unlisten>
  onAgentUpdated(callback: (event: AgentUpdatedEvent) => void): Promise<Unlisten>
}

export interface DesktopLifecycleSink {
  todoEvent(snapshot: TodoListSnapshot): SnapshotApplyResult
  todoSnapshot(snapshot: TodoListSnapshot): SnapshotApplyResult
  agentEvent(snapshot: AgentRuntimeSnapshot): SnapshotApplyResult
  agentSnapshot(snapshot: AgentRuntimeSnapshot): SnapshotApplyResult
}

const desktopLifecycleSource: DesktopLifecycleSource = {
  todoSnapshot: (sessionId) => desktopApi.todo.snapshot(sessionId),
  agentSnapshot: (sessionId) => desktopApi.agent.snapshot(sessionId),
  onTodoUpdated: (callback) => desktopEvents.todo.onUpdated(callback),
  onAgentUpdated: (callback) => desktopEvents.agent.onUpdated(callback)
}

const desktopLifecycleSink: DesktopLifecycleSink = {
  todoEvent: (snapshot) => {
    const result = useDesktopLifecycleStore.getState().applyTodoEvent(snapshot)
    if (result === 'applied') {
      useChatStore.getState().setSessionTodos(snapshot.sessionId, snapshot.items)
    }
    return result
  },
  todoSnapshot: (snapshot) => {
    const result = useDesktopLifecycleStore.getState().applyTodoSnapshot(snapshot)
    if (result === 'applied') {
      useChatStore.getState().setSessionTodos(snapshot.sessionId, snapshot.items)
    }
    return result
  },
  agentEvent: (snapshot) => useDesktopLifecycleStore.getState().applyAgentEvent(snapshot),
  agentSnapshot: (snapshot) => useDesktopLifecycleStore.getState().applyAgentSnapshot(snapshot)
}

export function startDesktopLifecycleSubscription(
  sessionId: string,
  source: DesktopLifecycleSource = desktopLifecycleSource,
  sink: DesktopLifecycleSink = desktopLifecycleSink
): Unlisten {
  let active = true
  let unlisteners: Unlisten[] = []
  const todoRefreshes = new Map<string, Promise<void>>()
  const agentRefreshes = new Map<string, Promise<void>>()

  const refreshTodo = (targetSessionId: string): Promise<void> => {
    const existing = todoRefreshes.get(targetSessionId)
    if (existing) return existing
    const refresh = source.todoSnapshot(targetSessionId)
      .then((snapshot) => {
        if (active) sink.todoSnapshot(snapshot)
      })
      .catch((error) => {
        if (active) console.warn('[desktopLifecycle] Todo snapshot refresh failed:', error)
      })
      .finally(() => todoRefreshes.delete(targetSessionId))
    todoRefreshes.set(targetSessionId, refresh)
    return refresh
  }

  const refreshAgent = (targetSessionId: string): Promise<void> => {
    const existing = agentRefreshes.get(targetSessionId)
    if (existing) return existing
    const refresh = source.agentSnapshot(targetSessionId)
      .then((snapshot) => {
        if (active) sink.agentSnapshot(snapshot)
      })
      .catch((error) => {
        if (active) console.warn('[desktopLifecycle] Agent snapshot refresh failed:', error)
      })
      .finally(() => agentRefreshes.delete(targetSessionId))
    agentRefreshes.set(targetSessionId, refresh)
    return refresh
  }

  const registrations = [
    source.onTodoUpdated((event) => {
      if (!active) return
      if (sink.todoEvent(event.snapshot) === 'gap') void refreshTodo(event.sessionId)
    }),
    source.onAgentUpdated((event) => {
      if (!active) return
      if (sink.agentEvent(event.snapshot) === 'gap') void refreshAgent(event.sessionId)
    })
  ]

  void Promise.allSettled(registrations).then((results) => {
    const registered = results.flatMap((result) => result.status === 'fulfilled'
      ? [result.value]
      : [])
    if (!active) {
      registered.forEach((unlisten) => unlisten())
      return
    }
    unlisteners = registered
    void Promise.allSettled([refreshTodo(sessionId), refreshAgent(sessionId)])
  })

  return () => {
    active = false
    unlisteners.forEach((unlisten) => unlisten())
    unlisteners = []
  }
}

export function useDesktopLifecycleSubscription(): void {
  const sessionId = useChatStore((state) => state.activeSessionId)

  useEffect(() => {
    if (!sessionId) return
    return startDesktopLifecycleSubscription(sessionId)
  }, [sessionId])
}
