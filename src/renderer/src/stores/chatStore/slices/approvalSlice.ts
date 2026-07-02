import type { StateCreator } from 'zustand'
import type { ChatState, PermissionRequestState, AskUserRequestState } from '../types'

export interface ApprovalSlice {
  addPermissionRequest: (
    msgId: string,
    request: Omit<PermissionRequestState, 'status' | 'createdAt'>
  ) => void
  resolvePermissionRequest: (msgId: string, requestId: string, approved: boolean) => void
  addAskUserRequest: (
    msgId: string,
    request: Omit<AskUserRequestState, 'status' | 'createdAt'>
  ) => void
  resolveAskUserRequest: (
    msgId: string,
    requestId: string,
    answers: Array<{ question: string; answer: string | string[] }>
  ) => void
}

export const createApprovalSlice: StateCreator<ChatState, [], [], ApprovalSlice> = (set, get) => ({
  addPermissionRequest: (msgId: string, request: Omit<PermissionRequestState, 'status' | 'createdAt'>) => {
    set((s) => {
      const msgs = s.messages.map((m) => {
        if (m.id !== msgId) return m
        const existing = m.permissionRequests || []
        if (existing.some((item) => item.id === request.id)) return m
        return {
          ...m,
          permissionRequests: [
            ...existing,
            {
              ...request,
              status: 'pending' as const,
              createdAt: Date.now()
            }
          ]
        }
      })
      const activeId = s.activeSessionId
      const sessions = s.sessions.map((session) =>
        session.id === activeId ? { ...session, messages: msgs } : session
      )
      return { messages: msgs, sessions }
    })
    get().persistCurrentSession()
  },

  resolvePermissionRequest: (msgId: string, requestId: string, approved: boolean) => {
    set((s) => {
      const msgs = s.messages.map((m) => {
        if (m.id !== msgId || !m.permissionRequests) return m
        return {
          ...m,
          permissionRequests: m.permissionRequests.map((request) =>
            request.id === requestId
              ? { ...request, status: approved ? ('approved' as const) : ('denied' as const) }
              : request
          )
        }
      })
      const activeId = s.activeSessionId
      const sessions = s.sessions.map((session) =>
        session.id === activeId ? { ...session, messages: msgs } : session
      )
      return { messages: msgs, sessions }
    })
    get().persistCurrentSession()
  },

  addAskUserRequest: (msgId, request) => {
    set((s) => {
      const msgs = s.messages.map((m) => {
        if (m.id !== msgId) return m
        const existing = m.askUserRequests || []
        if (existing.some((item) => item.id === request.id)) return m
        return {
          ...m,
          askUserRequests: [...existing, { ...request, status: 'pending' as const, createdAt: Date.now() }]
        }
      })
      const activeId = s.activeSessionId
      const sessions = s.sessions.map((session) =>
        session.id === activeId ? { ...session, messages: msgs } : session
      )
      return { messages: msgs, sessions }
    })
    get().persistCurrentSession()
  },

  resolveAskUserRequest: (msgId, requestId, answers) => {
    set((s) => {
      const msgs = s.messages.map((m) => {
        if (m.id !== msgId || !m.askUserRequests) return m
        return {
          ...m,
          askUserRequests: m.askUserRequests.map((r) =>
            r.id === requestId ? { ...r, status: 'answered' as const, answers } : r
          )
        }
      })
      const activeId = s.activeSessionId
      const sessions = s.sessions.map((session) =>
        session.id === activeId ? { ...session, messages: msgs } : session
      )
      return { messages: msgs, sessions }
    })
    get().persistCurrentSession()
  }
})
