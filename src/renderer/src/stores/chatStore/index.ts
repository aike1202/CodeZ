import { create } from 'zustand'
import type { ChatState } from './types'
import { createSessionSlice } from './slices/sessionSlice'
import { createMessageSlice } from './slices/messageSlice'
import { createApprovalSlice } from './slices/approvalSlice'
import { createContextSlice } from './slices/contextSlice'

export const useChatStore = create<ChatState>((...a) => ({
  ...createSessionSlice(...a),
  ...createMessageSlice(...a),
  ...createApprovalSlice(...a),
  ...createContextSlice(...a)
}))

export * from './types'
