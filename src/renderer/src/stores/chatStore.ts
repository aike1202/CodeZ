import { create } from 'zustand'

export type AgentStateType = 
  | 'processing' 
  | 'command_running' 
  | 'command_completed' 
  | 'exploration' 
  | 'edit' 
  | 'todo'

export interface AgentState {
  id: string
  type: AgentStateType
  title: string
  detail?: string
  status?: 'pending' | 'success' | 'error'
  timestamp: number
}

export interface ToolCallState {
  id: string
  name: string
  args: string
  status: 'running' | 'success' | 'error'
  result?: string
  startedAt: number
  completedAt?: number
  sequence: number
  thoughtSignature?: string
}

export interface ReasoningTimelineItem {
  id: string
  type: 'reasoning'
  content: string
  status: 'running' | 'success'
  startedAt: number
  updatedAt: number
  completedAt?: number
  sequence: number
}

export interface ToolTimelineItem {
  id: string
  type: 'tool'
  toolCall: ToolCallState
  startedAt: number
  updatedAt: number
  sequence: number
}

export interface TextTimelineItem {
  id: string
  type: 'text'
  content: string
  status: 'running' | 'success'
  startedAt: number
  updatedAt: number
  completedAt?: number
  sequence: number
}

export type ExecutionTimelineItem = ReasoningTimelineItem | ToolTimelineItem | TextTimelineItem

export interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  content: string
  /** 是否正在流式接收中 */
  streaming?: boolean
  /** 思考/推理的中间过程内容 */
  reasoningContent?: string
  /** Agent 执行流水线状态 */
  agentStates?: AgentState[]
  /** 真实工具调用记录 */
  toolCalls?: ToolCallState[]
  /** 按真实发生顺序组织的思考/工具执行时间线 */
  executionTimeline?: ExecutionTimelineItem[]
  /** 该消息对应的文件编辑事务 ID，用于 Accept/Reject */
  txId?: string
  /** 记录各个文件的 Accept/Reject 状态 (key: filePath) */
  editStatuses?: Record<string, 'accepted' | 'rejected'>
}

export interface ChatSession {
  id: string
  projectId: string
  summary: string
  relativeTime: string
  messages: ChatMessage[]
  isArchived?: boolean
  isDeleted?: boolean
  deletedAt?: number
}

function genId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function relativeTime(date: Date): string {
  const diff = Date.now() - date.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${Math.max(mins, 1)} 分钟前`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} 小时前`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days} 天前`
  return `${Math.floor(days / 30)} 个月前`
}

interface ChatState {
  sessions: ChatSession[]
  activeSessionId: string | null
  messages: ChatMessage[]
  /** 流式请求的 cleanup 函数，用于取消 */
  streamCleanup: (() => void) | null

  /* actions */
  loadSessions: () => Promise<void>
  createSession: (projectId: string) => string
  selectSession: (sessionId: string) => void
  addUserMessage: (content: string) => ChatMessage
  startStreamingReply: () => string  // 返回 agent 消息 id
  appendStreamChunk: (msgId: string, delta: string, reasoningDelta?: string) => void
  finishStreaming: (msgId: string) => void
  setStreamCleanup: (cleanup: (() => void) | null) => void
  setTransactionId: (msgId: string, txId: string) => void
  setEditStatus: (msgId: string, filePath: string, status: 'accepted' | 'rejected') => void
  persistCurrentSession: () => Promise<void>
  archiveSession: (sessionId: string, archive: boolean) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  restoreSession: (sessionId: string) => Promise<void>
  
  appendAgentState: (msgId: string, state: AgentState) => void
  updateAgentState: (msgId: string, stateId: string, updates: Partial<AgentState>) => void
  appendReasoningTimelineChunk: (msgId: string, delta: string) => void
  completeReasoningTimeline: (msgId: string) => void
  startToolCall: (msgId: string, toolCall: Omit<ToolCallState, 'status' | 'startedAt' | 'sequence'>) => void
  finishToolCall: (msgId: string, toolCallId: string, result: string) => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  streamCleanup: null,

  loadSessions: async () => {
    try {
      const sessions = await window.api.session.list()
      if (Array.isArray(sessions) && sessions.length > 0) {
        set({ sessions })
      }
    } catch {
      // 静默失败
    }
  },

  createSession: (projectId: string) => {
    const id = genId()
    const session: ChatSession = {
      id,
      projectId,
      summary: '新会话',
      relativeTime: '刚刚',
      messages: []
    }
    set((s) => ({
      sessions: [session, ...s.sessions],
      activeSessionId: id,
      messages: []
    }))
    return id
  },

  selectSession: (sessionId: string) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (session) {
      set({
        activeSessionId: sessionId,
        messages: session.messages
      })
    }
  },

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
            : (reasoningDelta || undefined)
          
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
              timeline = [...timeline, {
                id: genId(),
                type: 'text',
                content: delta,
                status: 'running',
                startedAt: now,
                updatedAt: now,
                sequence: timeline.length
              }]
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
        const timeline = (m.executionTimeline || []).map(item => 
          item.type === 'text' && item.status === 'running'
            ? { ...item, status: 'success' as const, completedAt: now, updatedAt: now }
            : item
        )
        return { ...m, streaming: false, txId, executionTimeline: timeline }
      })
      // 更新 session
      const activeId = s.activeSessionId
      const sessions = s.sessions.map((session) =>
        session.id === activeId
          ? { ...session, messages: msgs, summary: msgs[0]?.content.slice(0, 60) || '新会话', relativeTime: '刚刚' }
          : session
      )
      return { messages: msgs, sessions }
    })
  },

  setStreamCleanup: (cleanup) => {
    set({ streamCleanup: cleanup })
  },

  setTransactionId: (msgId, txId) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === msgId ? { ...m, txId } : m
      )
    }))
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

  persistCurrentSession: async () => {
    const { sessions, activeSessionId } = get()
    const session = sessions.find((s) => s.id === activeSessionId)
    if (session) {
      try {
        await window.api.session.save(session)
      } catch {
        // 静默失败
      }
    }
  },

  archiveSession: async (sessionId: string, archive: boolean) => {
    set((s) => {
      const msgs = s.sessions.map((session) => 
        session.id === sessionId ? { ...session, isArchived: archive } : session
      )
      return { sessions: msgs }
    })
    const session = get().sessions.find((s) => s.id === sessionId)
    if (session) {
      try {
        await window.api.session.save(session)
      } catch {}
    }
  },

  deleteSession: async (sessionId: string) => {
    let isAlreadyDeleted = false
    set((s) => {
      const session = s.sessions.find(x => x.id === sessionId)
      isAlreadyDeleted = !!session?.isDeleted
      
      let newSessions: ChatSession[]
      if (isAlreadyDeleted) {
        newSessions = s.sessions.filter((x) => x.id !== sessionId)
      } else {
        newSessions = s.sessions.map((x) => 
          x.id === sessionId ? { ...x, isDeleted: true, deletedAt: Date.now() } : x
        )
      }
      
      return {
        sessions: newSessions,
        activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
        messages: s.activeSessionId === sessionId ? [] : s.messages
      }
    })
    try {
      await window.api.session.delete(sessionId)
    } catch {}
  },

  restoreSession: async (sessionId: string) => {
    set((s) => {
      const newSessions = s.sessions.map((session) => 
        session.id === sessionId ? { ...session, isDeleted: false, deletedAt: undefined } : session
      )
      return { sessions: newSessions }
    })
    const session = get().sessions.find((s) => s.id === sessionId)
    if (session) {
      try {
        await window.api.session.save(session)
      } catch {}
    }
  },

  appendAgentState: (msgId: string, state: AgentState) => {
    set((s) => ({
      messages: s.messages.map((m) => 
        m.id === msgId 
          ? { ...m, agentStates: [...(m.agentStates || []), state] }
          : m
      )
    }))
  },

  updateAgentState: (msgId: string, stateId: string, updates: Partial<AgentState>) => {
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id === msgId && m.agentStates) {
          return {
            ...m,
            agentStates: m.agentStates.map(st =>
              st.id === stateId ? { ...st, ...updates } : st
            )
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
              item.id === toolCall.id ? { ...item, name: toolCall.name, args: toolCall.args, thoughtSignature: toolCall.thoughtSignature || item.thoughtSignature } : item
            ),
            executionTimeline: timeline.map((item) =>
              item.id === `tool_${toolCall.id}` && item.type === 'tool'
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
          id: `tool_${toolCall.id}`,
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
        const updateToolCall = (toolCall: ToolCallState): ToolCallState =>
          toolCall.id === toolCallId
            ? {
                ...toolCall,
                result,
                status: result.startsWith('Error:') ? 'error' : 'success',
                completedAt: now
              }
            : toolCall
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
  }
}))
