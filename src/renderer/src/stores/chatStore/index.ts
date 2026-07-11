import { create } from 'zustand'
import type { ChatState } from './types'
import { createSessionSlice } from './slices/sessionSlice'
import { createMessageSlice } from './slices/messageSlice'
import { createApprovalSlice } from './slices/approvalSlice'
import { createContextSlice } from './slices/contextSlice'
import { createRuntimeStatusSlice } from './slices/runtimeStatusSlice'

export const useChatStore = create<ChatState>((...a) => ({
  ...createSessionSlice(...a),
  ...createMessageSlice(...a),
  ...createApprovalSlice(...a),
  ...createContextSlice(...a),
  ...createRuntimeStatusSlice(...a)
}))

export * from './types'
