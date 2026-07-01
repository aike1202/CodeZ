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
  /** 事务生成的真实 diff 列表 */
  diffEntries?: Array<{ path: string; diff: string }>
  /** 等待用户审批的权限请求 */
  permissionRequests?: PermissionRequestState[]
  /** 等待用户回答的提问请求 */
  askUserRequests?: AskUserRequestState[]
}

export interface PermissionRequestState {
  id: string
  toolName: string
  risk: string
  description: string
  args: any
  status: 'pending' | 'approved' | 'denied'
  createdAt: number
}

export interface AskUserOptionState { label: string; description?: string; preview?: string }
export interface AskUserQuestionItemState {
  question: string
  header: string
  options: AskUserOptionState[]
  multiSelect?: boolean
}
export interface AskUserRequestState {
  id: string
  questions: AskUserQuestionItemState[]
  status: 'pending' | 'answered'
  answers?: Array<{ question: string; answer: string | string[] }>
  createdAt: number
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
  /** 当前展开的胶囊：'task' | 'plan' | null */
  expandedCapsule: 'task' | 'plan' | null
  /** Plan 模式开关：true=只读探索，false=正常模式 */
  planMode: boolean
  /** Plan 列表弹窗 */
  planListModalOpen: boolean
  /** 当前活跃 Plan（executing 状态） */
  activePlan: any | null
  /** 待审批 Plan（pending_review 状态） */
  planReview: { plan: any; status: string } | null
  /** 当前流的 streamId（用于 Plan 审批 IPC） */
  activePlanStreamId: string | null

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
  setDiffEntries: (msgId: string, diffEntries: Array<{ path: string; diff: string }>) => void
  setEditStatus: (msgId: string, filePath: string, status: 'accepted' | 'rejected') => void
  addPermissionRequest: (msgId: string, request: Omit<PermissionRequestState, 'status' | 'createdAt'>) => void
  resolvePermissionRequest: (msgId: string, requestId: string, approved: boolean) => void
  addAskUserRequest: (msgId: string, request: Omit<AskUserRequestState, 'status' | 'createdAt'>) => void
  resolveAskUserRequest: (msgId: string, requestId: string, answers: Array<{ question: string; answer: string | string[] }>) => void
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

  setExpandedCapsule: (capsule: 'task' | 'plan' | null) => void
  setPlanMode: (mode: boolean) => void
  togglePlanMode: () => void
  initPlanStateListener: () => void
  setPlanListModalOpen: (open: boolean) => void
  setActivePlan: (plan: any | null) => void
  setPlanReview: (review: { plan: any; status: string } | null) => void
  setActivePlanStreamId: (streamId: string | null) => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  streamCleanup: null,
  expandedCapsule: null,
  planMode: false,
  planListModalOpen: false,
  activePlan: null,
  planReview: null,
  activePlanStreamId: null,

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

  setDiffEntries: (msgId, diffEntries) => {
    set((s) => {
      const msgs = s.messages.map((m) =>
        m.id === msgId ? { ...m, diffEntries } : m
      )
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
              ? { ...request, status: approved ? 'approved' as const : 'denied' as const }
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
        return { ...m, askUserRequests: [...existing, { ...request, status: 'pending' as const, createdAt: Date.now() }] }
      })
      const activeId = s.activeSessionId
      const sessions = s.sessions.map((session) => session.id === activeId ? { ...session, messages: msgs } : session)
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
      const sessions = s.sessions.map((session) => session.id === activeId ? { ...session, messages: msgs } : session)
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

  setPlanMode: (mode) => set({ planMode: mode }),

  togglePlanMode: () => set((s) => ({ planMode: !s.planMode })),

  initPlanStateListener: () => {
    const win = window as any
    const ipc = win?.electron?.ipcRenderer
    if (!ipc) return

    ipc.on('plan:state-changed', (_event: unknown, data: { state: string; mode: string }) => {
      if (data.mode === 'normal') {
        useChatStore.getState().setPlanMode(false)
      }
    })

    ipc.on('plan:review-request', (_event: unknown, streamId: string, plan: any) => {
      useChatStore.getState().setActivePlanStreamId(streamId)
      useChatStore.getState().setPlanReview({ plan, status: 'pending_review' })
    })
  },

  setPlanListModalOpen: (open) => set({ planListModalOpen: open }),
  setActivePlan: (plan) => set({ activePlan: plan }),
  setPlanReview: (review) => set({ planReview: review }),
  setActivePlanStreamId: (streamId) => set({ activePlanStreamId: streamId })
}))
