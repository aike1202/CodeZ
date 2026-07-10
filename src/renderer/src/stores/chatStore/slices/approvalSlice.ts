import type { StateCreator } from 'zustand'
import type { ChatState, PermissionRequestState, AskUserRequestState } from '../types'
import { updateMessageInState } from './messageSlice'
import type { PermissionApprovalResponse } from '../../../../../shared/types/permission'

export interface ApprovalSlice {
  addPermissionRequest: (
    msgId: string,
    request: Omit<PermissionRequestState, 'status' | 'createdAt'>
  ) => void
  resolvePermissionRequest: (msgId: string, requestId: string, response: PermissionApprovalResponse) => void
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
    set((s) => updateMessageInState(s, msgId, (m) => {
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
    }))
    get().persistCurrentSession()
  },

  resolvePermissionRequest: (msgId: string, requestId: string, response: PermissionApprovalResponse) => {
    set((s) => updateMessageInState(s, msgId, (m) => {
      if (!m.permissionRequests) return m
      return {
        ...m,
        permissionRequests: m.permissionRequests.map((req) =>
          req.id === requestId
            ? { ...req, status: response.approved ? ('approved' as const) : ('denied' as const) }
            : req
        )
      }
    }))
    get().persistCurrentSession()
  },

  addAskUserRequest: (msgId, request) => {
    set((s) => updateMessageInState(s, msgId, (m) => {
      const existing = m.askUserRequests || []
      if (existing.some((item) => item.id === request.id)) return m
      return {
        ...m,
        askUserRequests: [...existing, { ...request, status: 'pending' as const, createdAt: Date.now() }]
      }
    }))
    get().persistCurrentSession()
  },

  resolveAskUserRequest: (msgId, requestId, answers) => {
    set((s) => updateMessageInState(s, msgId, (m) => {
      if (!m.askUserRequests) return m
      return {
        ...m,
        askUserRequests: m.askUserRequests.map((r) =>
          r.id === requestId ? { ...r, status: 'answered' as const, answers } : r
        )
      }
    }))
    get().persistCurrentSession()
  }
})
