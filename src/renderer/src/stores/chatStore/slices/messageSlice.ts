import type { StateCreator } from 'zustand'
import type {
  ChatState,
  ChatMessage,
  AgentState,
  ToolCallState,
  ToolTimelineItem,
  ReasoningTimelineItem,
  ChatSession
} from '../types'

function genId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// 流式持久化防抖：避免每个 chunk 都落盘，但保证崩溃后最多丢失 500ms 的内容
let _persistTimer: ReturnType<typeof setTimeout> | null = null
function schedulePersist(get: () => ChatState) {
  if (_persistTimer) clearTimeout(_persistTimer)
  _persistTimer = setTimeout(() => {
    get().persistCurrentSession()
    _persistTimer = null
  }, 500)
}

export interface MessageSlice {
  messages: ChatMessage[]
  streamCleanups: Record<string, (() => void) | null>
  expandedCapsule: 'task' | 'plan' | null
  subAgentStatus: 'idle' | 'running' | 'completed' | 'failed'
  planListModalOpen: boolean
  activePlan: any | null
  planReview: { plan: any; status: string } | null
  activePlanStreamId: string | null
  pendingPrompt: string | null

  addUserMessage: (content: string) => ChatMessage
  addSystemMessage: (content: string) => ChatMessage
  startStreamingReply: () => string
  appendStreamChunk: (msgId: string, delta: string, reasoningDelta?: string) => void
  finishStreaming: (msgId: string, txId?: string) => void
  setStreamCleanup: (sessionId: string, cleanup: (() => void) | null) => void
  setTransactionId: (msgId: string, txId: string) => void
  setDiffEntries: (msgId: string, diffEntries: Array<{ path: string; diff: string }>) => void
  setEditStatus: (msgId: string, filePath: string, status: 'accepted' | 'rejected') => void
  appendAgentState: (msgId: string, state: AgentState) => void
  updateAgentState: (msgId: string, stateId: string, updates: Partial<AgentState>) => void
  appendReasoningTimelineChunk: (msgId: string, delta: string) => void
  completeReasoningTimeline: (msgId: string) => void
  startToolCall: (msgId: string, toolCall: Omit<ToolCallState, 'status' | 'startedAt' | 'sequence'>) => void
  finishToolCall: (msgId: string, toolCallId: string, result: string) => void
  setExpandedCapsule: (capsule: 'task' | 'plan' | null) => void
  setSubAgentStatus: (status: 'idle' | 'running' | 'completed' | 'failed') => void
  initPlanStateListener: () => void
  setPlanListModalOpen: (open: boolean) => void
  setActivePlan: (plan: any | null) => void
  setPlanReview: (review: { plan: any; status: string } | null) => void
  setActivePlanStreamId: (streamId: string | null) => void
  setPendingPrompt: (prompt: string | null) => void
}

export function updateMessageInState(
  s: ChatState,
  msgId: string,
  updater: (m: ChatMessage) => ChatMessage,
  sessionUpdater?: (session: ChatSession, updatedMessages: ChatMessage[]) => ChatSession
): Partial<ChatState> {
  let foundSessionId: string | null = null
  const sessions = s.sessions.map((session) => {
    if (session.messages.some((m) => m.id === msgId)) {
      foundSessionId = session.id
      const updatedMessages = session.messages.map((m) => (m.id === msgId ? updater(m) : m))
      let updatedSession = { ...session, messages: updatedMessages }
      if (sessionUpdater) {
        updatedSession = sessionUpdater(updatedSession, updatedMessages)
      }
      return updatedSession
    }
    return session
  })

  // If not found in sessions, check active messages (fallback)
  if (!foundSessionId) {
    if (s.messages.some((m) => m.id === msgId)) {
      return { messages: s.messages.map((m) => (m.id === msgId ? updater(m) : m)) }
    }
    return {}
  }

  const result: Partial<ChatState> = { sessions }
  if (foundSessionId === s.activeSessionId) {
    const actSession = sessions.find((x) => x.id === foundSessionId)
    if (actSession) {
      result.messages = actSession.messages
    }
  }
  return result
}

export const createMessageSlice: StateCreator<ChatState, [], [], MessageSlice> = (set, get) => ({
  messages: [],
  streamCleanups: {},
  expandedCapsule: null,
  subAgentStatus: 'idle',
  planListModalOpen: false,
  activePlan: null,
  planReview: null,
  activePlanStreamId: null,
  pendingPrompt: null,

  addUserMessage: (content: string) => {
    const msg: ChatMessage = {
      id: genId(),
      role: 'user',
      content
    }
    set((s) => {
      const nextMsgs = [...s.messages, msg]
      const activeId = s.activeSessionId
      const sessions = s.sessions.map((session) =>
        session.id === activeId ? { ...session, messages: nextMsgs } : session
      )
      return { messages: nextMsgs, sessions }
    })
    get().persistCurrentSession()
    return msg
  },

  addSystemMessage: (content: string) => {
    const msg: ChatMessage = {
      id: genId(),
      role: 'system',
      content
    }
    set((s) => {
      const nextMsgs = [...s.messages, msg]
      const activeId = s.activeSessionId
      const sessions = s.sessions.map((session) =>
        session.id === activeId ? { ...session, messages: nextMsgs } : session
      )
      return { messages: nextMsgs, sessions }
    })
    get().persistCurrentSession()
    return msg
  },

  startStreamingReply: () => {
    const msg: ChatMessage = {
      id: genId(),
      role: 'agent',
      content: '',
      streaming: true
    }
    set((s) => {
      const nextMsgs = [...s.messages, msg]
      const activeId = s.activeSessionId
      const sessions = s.sessions.map((session) =>
        session.id === activeId ? { ...session, messages: nextMsgs } : session
      )
      return { messages: nextMsgs, sessions }
    })
    get().persistCurrentSession()
    return msg.id
  },

  appendStreamChunk: (msgId: string, delta: string, reasoningDelta?: string) => {
    set((s) => updateMessageInState(s, msgId, (m) => {
      const newContent = m.content + (delta || '')
      const newReasoning = m.reasoningContent
        ? m.reasoningContent + (reasoningDelta || '')
        : reasoningDelta || undefined

      let timeline = m.executionTimeline || []
      if (delta) {
        const now = Date.now()
        const last = timeline[timeline.length - 1]
        if (last?.type === 'text') {
          timeline = timeline.map((item) =>
            item.id === last.id && item.type === 'text'
              ? { ...item, content: item.content + delta, updatedAt: now }
              : item
          )
        } else {
          timeline = [
            ...timeline,
            {
              id: genId(),
              type: 'text',
              content: delta,
              status: 'running',
              startedAt: now,
              updatedAt: now,
              sequence: timeline.length
            }
          ]
        }
      }

      return { ...m, content: newContent, reasoningContent: newReasoning, executionTimeline: timeline }
    }))
    schedulePersist(get)
  },

  finishStreaming: (msgId: string, txId?: string) => {
    // 清除流式防抖 timer，因为 onDone/onError 会立即做完整持久化
    if (_persistTimer) {
      clearTimeout(_persistTimer)
      _persistTimer = null
    }
    set((s) => updateMessageInState(
      s,
      msgId,
      (m) => {
        const now = Date.now()
        const timeline = (m.executionTimeline || []).map((item) =>
          item.type === 'text' && item.status === 'running'
            ? { ...item, status: 'success' as const, completedAt: now, updatedAt: now }
            : item
        )
        return { ...m, streaming: false, txId, executionTimeline: timeline }
      },
      (session, updatedMessages) => ({
        ...session,
        summary: updatedMessages[0]?.content.slice(0, 60) || '新会话',
        relativeTime: '刚刚'
      })
    ))
  },

  setStreamCleanup: (sessionId, cleanup) => {
    set((s) => {
      const next = { ...s.streamCleanups }
      if (cleanup === null) {
        delete next[sessionId]
      } else {
        next[sessionId] = cleanup
      }
      return { streamCleanups: next }
    })
  },

  setTransactionId: (msgId, txId) => {
    set((s) => updateMessageInState(s, msgId, (m) => ({ ...m, txId })))
  },

  setDiffEntries: (msgId, diffEntries) => {
    set((s) => updateMessageInState(s, msgId, (m) => ({ ...m, diffEntries })))
    get().persistCurrentSession()
  },

  setEditStatus: (msgId: string, filePath: string, status: 'accepted' | 'rejected') => {
    set((s) => updateMessageInState(s, msgId, (m) => {
      const newStatuses = { ...(m.editStatuses || {}) }
      newStatuses[filePath] = status
      return { ...m, editStatuses: newStatuses }
    }))
    get().persistCurrentSession()
  },

  appendAgentState: (msgId: string, state: AgentState) => {
    set((s) => updateMessageInState(s, msgId, (m) => ({ ...m, agentStates: [...(m.agentStates || []), state] })))
  },

  updateAgentState: (msgId: string, stateId: string, updates: Partial<AgentState>) => {
    set((s) => updateMessageInState(s, msgId, (m) => {
      if (m.agentStates) {
        return {
          ...m,
          agentStates: m.agentStates.map((st) => (st.id === stateId ? { ...st, ...updates } : st))
        }
      }
      return m
    }))
  },

  appendReasoningTimelineChunk: (msgId: string, delta: string) => {
    if (!delta) return

    set((s) => updateMessageInState(s, msgId, (m) => {
      const now = Date.now()
      const timeline = m.executionTimeline || []
      const last = timeline[timeline.length - 1]

      if (last?.type === 'reasoning') {
        return {
          ...m,
          executionTimeline: timeline.map((item) => {
            if (item.id !== last.id || item.type !== 'reasoning') return item
            return { ...item, content: item.content + delta, status: 'running', updatedAt: now }
          })
        }
      }

      const nextItem: ReasoningTimelineItem = {
        id: genId(),
        type: 'reasoning',
        content: delta,
        status: 'running',
        startedAt: now,
        updatedAt: now,
        sequence: timeline.length
      }

      return {
        ...m,
        executionTimeline: [...timeline, nextItem]
      }
    }))
    schedulePersist(get)
  },

  completeReasoningTimeline: (msgId: string) => {
    set((s) => updateMessageInState(s, msgId, (m) => {
      if (!m.executionTimeline) return m

      const now = Date.now()
      return {
        ...m,
        executionTimeline: m.executionTimeline.map((item) =>
          item.type === 'reasoning' && item.status === 'running'
            ? { ...item, status: 'success', updatedAt: now, completedAt: now }
            : item
        )
      }
    }))
  },

  startToolCall: (msgId: string, toolCall: Omit<ToolCallState, 'status' | 'startedAt' | 'sequence'>) => {
    set((s) => updateMessageInState(s, msgId, (m) => {
      const existing = m.toolCalls || []
      const timeline = m.executionTimeline || []
      const now = Date.now()

      const alreadyExists = existing.some((item) => item.id === toolCall.id)
      if (alreadyExists) {
        return {
          ...m,
          toolCalls: existing.map((item) =>
            item.id === toolCall.id
              ? {
                  ...item,
                  name: toolCall.name,
                  args: toolCall.args,
                  thoughtSignature: toolCall.thoughtSignature || item.thoughtSignature
                }
              : item
          ),
          executionTimeline: timeline.map((item) =>
            item.id === 'tool_' + toolCall.id && item.type === 'tool'
              ? {
                  ...item,
                  toolCall: { ...item.toolCall, name: toolCall.name, args: toolCall.args },
                  updatedAt: now
                }
              : item
          )
        }
      }

      const nextToolCall: ToolCallState = {
        ...toolCall,
        status: 'running',
        startedAt: now,
        sequence: existing.length
      }
      const nextTimelineItem: ToolTimelineItem = {
        id: 'tool_' + toolCall.id,
        type: 'tool',
        toolCall: nextToolCall,
        startedAt: now,
        updatedAt: now,
        sequence: timeline.length
      }

      return {
        ...m,
        toolCalls: [...existing, nextToolCall].sort((a, b) => a.sequence - b.sequence),
        executionTimeline: [...timeline, nextTimelineItem].sort((a, b) => a.sequence - b.sequence)
      }
    }))
  },

  finishToolCall: (msgId: string, toolCallId: string, result: string) => {
    set((s) => updateMessageInState(s, msgId, (m) => {
      if (!m.toolCalls) return m

      const now = Date.now()
      const updateToolCall = (toolCall: ToolCallState): ToolCallState => {
        if (toolCall.id !== toolCallId) return toolCall

        let hasStructuredError = false
        try {
          const parsed = JSON.parse(result)
          hasStructuredError = parsed?.ok === false || Boolean(parsed?.error && !parsed?.data)
        } catch {
          hasStructuredError = false
        }

        return {
          ...toolCall,
          result,
          status: result.startsWith('Error:') || hasStructuredError ? 'error' : 'success',
          completedAt: now
        }
      }

      const nextToolCalls = m.toolCalls.map(updateToolCall)

      return {
        ...m,
        toolCalls: nextToolCalls,
        executionTimeline: (m.executionTimeline || []).map((item) =>
          item.type === 'tool' && item.toolCall.id === toolCallId
            ? { ...item, toolCall: updateToolCall(item.toolCall), updatedAt: now }
            : item
        )
      }
    }))
  },

  setExpandedCapsule: (capsule) => set({ expandedCapsule: capsule }),
  setSubAgentStatus: (status) => set({ subAgentStatus: status }),

  initPlanStateListener: () => {
    const win = window as any
    const ipc = win?.electron?.ipcRenderer
    if (!ipc) return

    ipc.on(
      'plan:subagent-progress',
      (_event: unknown, data: { status: 'idle' | 'running' | 'completed' | 'failed' }) => {
        get().setSubAgentStatus(data.status)
      }
    )

    ipc.on('plan:review-request', (_event: unknown, streamId: string, plan: any) => {
      get().setActivePlanStreamId(streamId)
      get().setPlanReview({ plan, status: 'pending_review' })
    })

    ipc.on('plan:state-changed', (_event: unknown, plan: any) => {
      get().setActivePlan(plan)
    })

    ipc.on('plan:linked', (_event: unknown, data: { sessionId: string; plan: any }) => {
      get().linkPlanToSession(data.sessionId, data.plan.slug)
      get().setActivePlan(data.plan)
    })
  },

  setPlanListModalOpen: (open) => set({ planListModalOpen: open }),
  setActivePlan: (plan) => set({ activePlan: plan }),
  setPlanReview: (review) => set({ planReview: review }),
  setActivePlanStreamId: (streamId) => set({ activePlanStreamId: streamId }),
  setPendingPrompt: (prompt) => set({ pendingPrompt: prompt })
})
