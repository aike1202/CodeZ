import type { StateCreator } from 'zustand'
import type {
  ChatState,
  ChatMessage,
  AgentState,
  ToolCallState,
  ToolTimelineItem,
  ReasoningTimelineItem
} from '../types'

function genId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export interface MessageSlice {
  messages: ChatMessage[]
  streamCleanup: (() => void) | null
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
  setStreamCleanup: (cleanup: (() => void) | null) => void
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

export const createMessageSlice: StateCreator<ChatState, [], [], MessageSlice> = (set, get) => ({
  messages: [],
  streamCleanup: null,
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
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id === msgId) {
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
        }
        return m
      })
    }))
  },

  finishStreaming: (msgId: string, txId?: string) => {
    set((s) => {
      const msgs = s.messages.map((m) => {
        if (m.id !== msgId) return m
        const now = Date.now()
        const timeline = (m.executionTimeline || []).map((item) =>
          item.type === 'text' && item.status === 'running'
            ? { ...item, status: 'success' as const, completedAt: now, updatedAt: now }
            : item
        )
        return { ...m, streaming: false, txId, executionTimeline: timeline }
      })
      const activeId = s.activeSessionId
      const sessions = s.sessions.map((session) =>
        session.id === activeId
          ? { ...session, messages: msgs, summary: msgs[0]?.content.slice(0, 60) || '新会话', relativeTime: '刚刚' }
          : session
      )
      return { messages: msgs, sessions }
    })
  },

  setStreamCleanup: (cleanup) => set({ streamCleanup: cleanup }),

  setTransactionId: (msgId, txId) => {
    set((s) => ({
      messages: s.messages.map((m) => (m.id === msgId ? { ...m, txId } : m))
    }))
  },

  setDiffEntries: (msgId, diffEntries) => {
    set((s) => {
      const msgs = s.messages.map((m) => (m.id === msgId ? { ...m, diffEntries } : m))
      const activeId = s.activeSessionId
      const sessions = s.sessions.map((session) =>
        session.id === activeId ? { ...session, messages: msgs } : session
      )
      return { messages: msgs, sessions }
    })
    get().persistCurrentSession()
  },

  setEditStatus: (msgId: string, filePath: string, status: 'accepted' | 'rejected') => {
    set((s) => {
      const msgs = s.messages.map((m) => {
        if (m.id === msgId) {
          const newStatuses = { ...(m.editStatuses || {}) }
          newStatuses[filePath] = status
          return { ...m, editStatuses: newStatuses }
        }
        return m
      })
      const activeId = s.activeSessionId
      const sessions = s.sessions.map((session) =>
        session.id === activeId ? { ...session, messages: msgs } : session
      )
      return { messages: msgs, sessions }
    })
    get().persistCurrentSession()
  },

  appendAgentState: (msgId: string, state: AgentState) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === msgId ? { ...m, agentStates: [...(m.agentStates || []), state] } : m
      )
    }))
  },

  updateAgentState: (msgId: string, stateId: string, updates: Partial<AgentState>) => {
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id === msgId && m.agentStates) {
          return {
            ...m,
            agentStates: m.agentStates.map((st) => (st.id === stateId ? { ...st, ...updates } : st))
          }
        }
        return m
      })
    }))
  },

  appendReasoningTimelineChunk: (msgId: string, delta: string) => {
    if (!delta) return

    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== msgId) return m

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
      })
    }))
  },

  completeReasoningTimeline: (msgId: string) => {
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== msgId || !m.executionTimeline) return m

        const now = Date.now()
        return {
          ...m,
          executionTimeline: m.executionTimeline.map((item) =>
            item.type === 'reasoning' && item.status === 'running'
              ? { ...item, status: 'success', updatedAt: now, completedAt: now }
              : item
          )
        }
      })
    }))
  },

  startToolCall: (msgId: string, toolCall: Omit<ToolCallState, 'status' | 'startedAt' | 'sequence'>) => {
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== msgId) return m

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
      })
    }))
  },

  finishToolCall: (msgId: string, toolCallId: string, result: string) => {
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== msgId || !m.toolCalls) return m

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
      })
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
