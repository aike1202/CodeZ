import { useEffect } from 'react'

import { desktopApi, desktopEvents } from '../../../shared/desktop'
import type {
  AgentRuntimeSnapshot,
  AgentUpdatedEvent,
  TaskSnapshot,
  TaskUpdatedEvent
} from '../../../shared/desktop/generated/contracts'
import { useChatStore } from '../../../stores/chatStore'
import {
  useDesktopLifecycleStore,
  type SnapshotApplyResult
} from '../../../stores/desktopLifecycleStore'

type Unlisten = () => void

export interface DesktopLifecycleSource {
  taskSnapshot(sessionId: string): Promise<TaskSnapshot>
  agentSnapshot(sessionId: string): Promise<AgentRuntimeSnapshot>
  onTaskUpdated(callback: (event: TaskUpdatedEvent) => void): Promise<Unlisten>
  onAgentUpdated(callback: (event: AgentUpdatedEvent) => void): Promise<Unlisten>
}

export interface DesktopLifecycleSink {
  taskEvent(snapshot: TaskSnapshot): SnapshotApplyResult
  taskSnapshot(snapshot: TaskSnapshot): SnapshotApplyResult
  agentEvent(snapshot: AgentRuntimeSnapshot): SnapshotApplyResult
  agentSnapshot(snapshot: AgentRuntimeSnapshot): SnapshotApplyResult
}

const desktopLifecycleSource: DesktopLifecycleSource = {
  taskSnapshot: (sessionId) => desktopApi.task.snapshot(sessionId),
  agentSnapshot: (sessionId) => desktopApi.agent.snapshot(sessionId),
  onTaskUpdated: (callback) => desktopEvents.task.onUpdated(callback),
  onAgentUpdated: (callback) => desktopEvents.agent.onUpdated(callback)
}

const desktopLifecycleSink: DesktopLifecycleSink = {
  taskEvent: (snapshot) => {
    const result = useDesktopLifecycleStore.getState().applyTaskEvent(snapshot)
    if (result === 'applied') {
      useChatStore.getState().setSessionTasks(snapshot.sessionId, snapshot.tasks)
    }
    return result
  },
  taskSnapshot: (snapshot) => {
    const result = useDesktopLifecycleStore.getState().applyTaskSnapshot(snapshot)
    if (result === 'applied') {
      useChatStore.getState().setSessionTasks(snapshot.sessionId, snapshot.tasks)
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
  const taskRefreshes = new Map<string, Promise<void>>()
  const agentRefreshes = new Map<string, Promise<void>>()

  const refreshTask = (targetSessionId: string): Promise<void> => {
    const existing = taskRefreshes.get(targetSessionId)
    if (existing) return existing
    const refresh = source.taskSnapshot(targetSessionId)
      .then((snapshot) => {
        if (active) sink.taskSnapshot(snapshot)
      })
      .catch((error) => {
        if (active) console.warn('[desktopLifecycle] Task snapshot refresh failed:', error)
      })
      .finally(() => taskRefreshes.delete(targetSessionId))
    taskRefreshes.set(targetSessionId, refresh)
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
    source.onTaskUpdated((event) => {
      if (!active) return
      if (sink.taskEvent(event.snapshot) === 'gap') void refreshTask(event.sessionId)
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
    void Promise.allSettled([refreshTask(sessionId), refreshAgent(sessionId)])
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
