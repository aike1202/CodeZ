import { useEffect } from 'react'

import { desktopApi, desktopEvents } from '../../../shared/desktop'
import type {
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
  onTodoUpdated(callback: (event: TodoUpdatedEvent) => void): Promise<Unlisten>
}

export interface DesktopLifecycleSink {
  todoEvent(snapshot: TodoListSnapshot): SnapshotApplyResult
  todoSnapshot(snapshot: TodoListSnapshot): SnapshotApplyResult
}

const desktopLifecycleSource: DesktopLifecycleSource = {
  todoSnapshot: (sessionId) => desktopApi.todo.snapshot(sessionId),
  onTodoUpdated: (callback) => desktopEvents.todo.onUpdated(callback)
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
  }
}

export function startDesktopLifecycleSubscription(
  sessionId: string,
  source: DesktopLifecycleSource = desktopLifecycleSource,
  sink: DesktopLifecycleSink = desktopLifecycleSink
): Unlisten {
  let active = true
  let unlisteners: Unlisten[] = []
  const todoRefreshes = new Map<string, Promise<void>>()

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

  const registrations = [
    source.onTodoUpdated((event) => {
      if (!active) return
      if (sink.todoEvent(event.snapshot) === 'gap') void refreshTodo(event.sessionId)
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
    void refreshTodo(sessionId)
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
