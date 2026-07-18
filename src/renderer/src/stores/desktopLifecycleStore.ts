import { create } from 'zustand'

import type {
  AgentRuntimeSnapshot,
  TodoListSnapshot
} from '../shared/desktop/generated/contracts'

export type SnapshotApplyResult = 'applied' | 'ignored' | 'gap'

interface DesktopLifecycleState {
  todoSnapshots: Record<string, TodoListSnapshot | undefined>
  agentSnapshots: Record<string, AgentRuntimeSnapshot | undefined>
  applyTodoEvent(snapshot: TodoListSnapshot): SnapshotApplyResult
  applyTodoSnapshot(snapshot: TodoListSnapshot): SnapshotApplyResult
  applyAgentEvent(snapshot: AgentRuntimeSnapshot): SnapshotApplyResult
  applyAgentSnapshot(snapshot: AgentRuntimeSnapshot): SnapshotApplyResult
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
  agentSnapshots: {},

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

  applyAgentEvent: (snapshot) => {
    const result = classifyRevision(
      get().agentSnapshots[snapshot.sessionId]?.revision,
      snapshot.revision,
      false
    )
    if (result === 'applied') {
      set((state) => ({
        agentSnapshots: { ...state.agentSnapshots, [snapshot.sessionId]: snapshot }
      }))
    }
    return result
  },

  applyAgentSnapshot: (snapshot) => {
    const result = classifyRevision(
      get().agentSnapshots[snapshot.sessionId]?.revision,
      snapshot.revision,
      true
    )
    if (result === 'applied') {
      set((state) => ({
        agentSnapshots: { ...state.agentSnapshots, [snapshot.sessionId]: snapshot }
      }))
    }
    return result
  },

  clearSession: (sessionId) => set((state) => {
    const todoSnapshots = { ...state.todoSnapshots }
    const agentSnapshots = { ...state.agentSnapshots }
    delete todoSnapshots[sessionId]
    delete agentSnapshots[sessionId]
    return { todoSnapshots, agentSnapshots }
  })
}))
