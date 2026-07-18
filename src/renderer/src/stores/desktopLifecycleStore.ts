import { create } from 'zustand'

import type {
  AgentRuntimeSnapshot,
  TodoListSnapshot as TaskSnapshot
} from '../shared/desktop/generated/contracts'

export type SnapshotApplyResult = 'applied' | 'ignored' | 'gap'

interface DesktopLifecycleState {
  taskSnapshots: Record<string, TaskSnapshot | undefined>
  agentSnapshots: Record<string, AgentRuntimeSnapshot | undefined>
  applyTaskEvent(snapshot: TaskSnapshot): SnapshotApplyResult
  applyTaskSnapshot(snapshot: TaskSnapshot): SnapshotApplyResult
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
  taskSnapshots: {},
  agentSnapshots: {},

  applyTaskEvent: (snapshot) => {
    const result = classifyRevision(
      get().taskSnapshots[snapshot.sessionId]?.revision,
      snapshot.revision,
      false
    )
    if (result === 'applied') {
      set((state) => ({
        taskSnapshots: { ...state.taskSnapshots, [snapshot.sessionId]: snapshot }
      }))
    }
    return result
  },

  applyTaskSnapshot: (snapshot) => {
    const result = classifyRevision(
      get().taskSnapshots[snapshot.sessionId]?.revision,
      snapshot.revision,
      true
    )
    if (result === 'applied') {
      set((state) => ({
        taskSnapshots: { ...state.taskSnapshots, [snapshot.sessionId]: snapshot }
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
    const taskSnapshots = { ...state.taskSnapshots }
    const agentSnapshots = { ...state.agentSnapshots }
    delete taskSnapshots[sessionId]
    delete agentSnapshots[sessionId]
    return { taskSnapshots, agentSnapshots }
  })
}))
