import { create } from 'zustand'
import type { ChatState } from './types'
import { createSessionSlice } from './slices/sessionSlice'
import { createMessageSlice } from './slices/messageSlice'
import { createApprovalSlice } from './slices/approvalSlice'

export const useChatStore = create<ChatState>((...a) => ({
  ...createSessionSlice(...a),
  ...createMessageSlice(...a),
  ...createApprovalSlice(...a)
}))

export * from './types'
