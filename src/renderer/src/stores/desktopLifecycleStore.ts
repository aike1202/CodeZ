import { create } from 'zustand'

import type { TodoListSnapshot } from '../shared/desktop/generated/contracts'

export type SnapshotApplyResult = 'applied' | 'ignored' | 'gap'

interface DesktopLifecycleState {
  todoSnapshots: Record<string, TodoListSnapshot | undefined>
  applyTodoEvent(snapshot: TodoListSnapshot): SnapshotApplyResult
  applyTodoSnapshot(snapshot: TodoListSnapshot): SnapshotApplyResult
  clearSession(sessionId: string): void
}

function classifyRevision(
  currentRevision: number | undefined,
  nextRevision: number,
  authoritative: boolean
): SnapshotApplyResult {
  if (currentRevision !== undefined && nextRevision <= currentRevision) return 'ignored'
  if (!authoritative && nextRevision > (currentRevision ?? 0) + 1) return 'gap'
  return 'applied'
}

export const useDesktopLifecycleStore = create<DesktopLifecycleState>((set, get) => ({
  todoSnapshots: {},

  applyTodoEvent: (snapshot) => {
    const result = classifyRevision(
      get().todoSnapshots[snapshot.sessionId]?.revision,
      snapshot.revision,
      false
    )
    if (result === 'applied') {
      set((state) => ({
        todoSnapshots: { ...state.todoSnapshots, [snapshot.sessionId]: snapshot }
      }))
    }
    return result
  },

  applyTodoSnapshot: (snapshot) => {
    const result = classifyRevision(
      get().todoSnapshots[snapshot.sessionId]?.revision,
      snapshot.revision,
      true
    )
    if (result === 'applied') {
      set((state) => ({
        todoSnapshots: { ...state.todoSnapshots, [snapshot.sessionId]: snapshot }
      }))
    }
    return result
  },

  clearSession: (sessionId) => set((state) => {
    const todoSnapshots = { ...state.todoSnapshots }
    delete todoSnapshots[sessionId]
    return { todoSnapshots }
  })
}))
