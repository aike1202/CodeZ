import type { StateCreator } from 'zustand'
import type {
  SessionRuntimeStatus,
  SessionRuntimeStatusChanged
} from '../../../../../shared/types/subagent'
import { desktopApi } from '../../../shared/desktop'
import type { ChatState } from '../types'

export interface RuntimeStatusSlice {
  runtimeStatuses: Record<string, SessionRuntimeStatusChanged | undefined>
  blockedRuntimeSessionIds: Record<string, true | undefined>
  applyRuntimeStatus: (next: SessionRuntimeStatusChanged) => void
  refreshRuntimeStatuses: (sessionIds: string[]) => Promise<void>
  clearRuntimeStatus: (sessionId: string) => void
  allowRuntimeStatus: (sessionId: string) => void
}

export const createRuntimeStatusSlice: StateCreator<ChatState, [], [], RuntimeStatusSlice> = (set, get) => ({
  runtimeStatuses: {},
  blockedRuntimeSessionIds: {},

  applyRuntimeStatus: (next) => set((state) => {
    const sessionId = next.status.sessionId
    if (state.blockedRuntimeSessionIds[sessionId]) return state
    const current = state.runtimeStatuses[sessionId]
    if (current && current.version >= next.version) return state
    return {
      runtimeStatuses: {
        ...state.runtimeStatuses,
        [sessionId]: next
      }
    }
  }),

  refreshRuntimeStatuses: async (sessionIds) => {
    const uniqueIds = [...new Set(sessionIds)]
    const results = await Promise.allSettled(
      uniqueIds.map(async (sessionId): Promise<SessionRuntimeStatus> =>
        desktopApi.chat.getRuntimeStatus(sessionId))
    )

    results.forEach((result, index) => {
      const sessionId = uniqueIds[index]
      if (result.status === 'rejected') {
        console.warn('[runtimeStatusSlice.refreshRuntimeStatuses] Failed:', sessionId, result.reason)
        return
      }
      if (get().runtimeStatuses[sessionId]) return
      get().applyRuntimeStatus({ version: 0, status: result.value })
    })
  },

  clearRuntimeStatus: (sessionId) => set((state) => {
    const runtimeStatuses = { ...state.runtimeStatuses }
    delete runtimeStatuses[sessionId]
    return {
      runtimeStatuses,
      blockedRuntimeSessionIds: {
        ...state.blockedRuntimeSessionIds,
        [sessionId]: true
      }
    }
  }),

  allowRuntimeStatus: (sessionId) => set((state) => {
    if (!state.blockedRuntimeSessionIds[sessionId]) return state
    const blockedRuntimeSessionIds = { ...state.blockedRuntimeSessionIds }
    delete blockedRuntimeSessionIds[sessionId]
    return { blockedRuntimeSessionIds }
  })
})
