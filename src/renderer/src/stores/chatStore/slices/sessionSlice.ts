import type { StateCreator } from 'zustand'
import type {
  AgentState,
  ChatMessage,
  ChatState,
  ChatSession,
  ExecutionTimelineItem,
  ToolCallState
} from '../types'
import { desktopApi } from '../../../shared/desktop'
import type { SessionData } from '@shared/types/session'
import type { ChatRuntimeStatus } from '../../../shared/desktop/generated/contracts'
import type { QueuedPrompt } from '../../../../../shared/types/queuedPrompt'

function genId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// 防竞态：每次 selectSession 分配递增序号，IPC 返回时检查是否仍是最新请求
let _selectSessionSeq = 0

function hasUnfinishedTodos(todos: Array<{ status: string }> | undefined): boolean {
  return Boolean(todos?.some((todo) => todo.status === 'pending' || todo.status === 'in_progress'))
}

function inactiveRuntimeStatus(sessionId: string): ChatRuntimeStatus {
  return { sessionId, mainRunnerActive: false }
}

const normalizeMessage = (message: ChatMessage): ChatMessage => ({
  ...message,
  attachments: Array.isArray(message.attachments)
    ? message.attachments.map((attachment) => ({ ...attachment }))
    : undefined
})

function normalizeSession(session: SessionData): ChatSession {
  return {
    ...session,
    todos: [],
    messages: Array.isArray(session.messages)
      ? session.messages.map((message) => normalizeMessage(message as ChatMessage))
      : [],
    queuedPrompts: Array.isArray(session.queuedPrompts)
      ? session.queuedPrompts.map((prompt) => ({
          ...prompt,
          attachments: Array.isArray(prompt.attachments)
            ? prompt.attachments.map((attachment) => ({ ...attachment }))
            : [],
          status: prompt.status === 'steering' ? 'queued' : prompt.status || 'queued'
        }))
      : []
  }
}

function persistedSession(session: ChatSession): SessionData {
  const { todos, ...rest } = session
  return rest
}

const RUNTIME_INTERRUPTED_ERROR =
  'Error: Execution was interrupted because the session runtime is no longer active.'

function settleRunningToolCalls(
  toolCalls: ToolCallState[] | undefined,
  completedAt: number
): { toolCalls: ToolCallState[] | undefined; changed: boolean } {
  if (!Array.isArray(toolCalls)) return { toolCalls, changed: false }
  let changed = false
  const settled = toolCalls.map((toolCall) => {
    if (toolCall.status !== 'running') return toolCall
    changed = true
    return {
      ...toolCall,
      status: 'error' as const,
      result: toolCall.result || RUNTIME_INTERRUPTED_ERROR,
      completedAt: toolCall.completedAt || completedAt
    }
  })
  return { toolCalls: changed ? settled : toolCalls, changed }
}

function settleRunningTimeline(
  timeline: ExecutionTimelineItem[] | undefined,
  completedAt: number
): { timeline: ExecutionTimelineItem[] | undefined; changed: boolean } {
  if (!Array.isArray(timeline)) return { timeline, changed: false }
  let changed = false
  const settled = timeline.map((item): ExecutionTimelineItem => {
    if (item.type === 'tool') {
      const toolResult = settleRunningToolCalls([item.toolCall], completedAt)
      if (!toolResult.changed) return item
      changed = true
      return {
        ...item,
        toolCall: toolResult.toolCalls![0],
        updatedAt: completedAt
      }
    }
    if (item.status !== 'running') return item
    changed = true
    if (item.type === 'compaction') {
      return {
        ...item,
        status: 'error',
        error: item.error || RUNTIME_INTERRUPTED_ERROR,
        updatedAt: completedAt,
        completedAt: item.completedAt || completedAt
      }
    }
    return {
      ...item,
      status: 'success',
      updatedAt: completedAt,
      completedAt: item.completedAt || completedAt
    }
  })
  return { timeline: changed ? settled : timeline, changed }
}

function settleRunningAgentStates(
  agentStates: AgentState[] | undefined
): { agentStates: AgentState[] | undefined; changed: boolean } {
  if (!Array.isArray(agentStates)) return { agentStates, changed: false }
  let changed = false
  const settled = agentStates.map((state): AgentState => {
    if (state.type === 'command_running') {
      changed = true
      return {
        ...state,
        type: 'command_completed',
        status: 'error',
        detail: state.detail || RUNTIME_INTERRUPTED_ERROR
      }
    }
    if (state.type === 'edit' && (
      state.status === 'pending' || state.title.startsWith('正在编辑')
    )) {
      changed = true
      return {
        ...state,
        title: state.title.replace(/^正在编辑\s*/u, '已中断编辑 '),
        status: 'error',
        detail: state.detail || RUNTIME_INTERRUPTED_ERROR
      }
    }
    return state
  })
  return { agentStates: changed ? settled : agentStates, changed }
}

function settleRunningExecutionState<
  T extends {
    toolCalls?: ToolCallState[]
    executionTimeline?: ExecutionTimelineItem[]
    agentStates?: AgentState[]
  }
>(owner: T, completedAt: number): { owner: T; changed: boolean } {
  const tools = settleRunningToolCalls(owner.toolCalls, completedAt)
  const timeline = settleRunningTimeline(owner.executionTimeline, completedAt)
  const states = settleRunningAgentStates(owner.agentStates)
  const changed = tools.changed || timeline.changed || states.changed
  if (!changed) return { owner, changed: false }
  return {
    owner: {
      ...owner,
      ...(tools.toolCalls ? { toolCalls: tools.toolCalls } : {}),
      ...(timeline.timeline ? { executionTimeline: timeline.timeline } : {}),
      ...(states.agentStates ? { agentStates: states.agentStates } : {})
    },
    changed: true
  }
}

export function interruptPendingRequests(
  messages: ChatMessage[],
  runtimeStatus: { sessionId: string; mainRunnerActive: boolean }
): { messages: ChatMessage[]; changed: boolean } {
  if (runtimeStatus.mainRunnerActive) return { messages, changed: false }

  let changed = false
  const nextMessages = messages.map((message) => {
    const hasPendingPermission = message.permissionRequests?.some((request) => request.status === 'pending')
    const hasPendingQuestion = message.askUserRequests?.some((request) => request.status === 'pending')
    if (!hasPendingPermission && !hasPendingQuestion) return message

    changed = true
    return {
      ...message,
      permissionRequests: message.permissionRequests?.map((request) =>
        request.status === 'pending' ? { ...request, status: 'interrupted' as const } : request),
      askUserRequests: message.askUserRequests?.map((request) =>
        request.status === 'pending' ? { ...request, status: 'interrupted' as const } : request)
    }
  })

  return { messages: nextMessages, changed }
}

function healInterruptedMessages(messages: ChatMessage[]): {
  messages: ChatMessage[]
  changed: boolean
} {
  let changed = false
  const healedMessages = messages.map((message) => {
    const completedAt = Date.now()
    const settled = settleRunningExecutionState(message, completedAt)
    if (!message.streaming && !settled.changed) return message
    changed = true
    return {
      ...settled.owner,
      streaming: false,
      streamPhase: undefined,
      responseWaitWarning: undefined,
      interrupted: true,
      executionStatus: 'interrupted' as const
    }
  })
  return { messages: healedMessages, changed }
}
export interface SessionSlice {
  sessions: ChatSession[]
  activeSessionId: string | null
  loadSessions: () => Promise<void>
  createSession: (projectId: string) => string
  selectSession: (sessionId: string) => Promise<void>
  linkPlanToSession: (sessionId: string, planSlug: string | null) => Promise<void>
  persistCurrentSession: () => Promise<void>
  persistSession: (sessionId: string) => Promise<void>
  enqueueQueuedPrompt: (
    sessionId: string,
    prompt: Omit<QueuedPrompt, 'id' | 'createdAt' | 'status'>
  ) => QueuedPrompt
  updateQueuedPrompt: (
    sessionId: string,
    promptId: string,
    patch: Partial<Pick<QueuedPrompt, 'text' | 'modelName' | 'attachments' | 'status'>>
  ) => QueuedPrompt | null
  removeQueuedPrompt: (sessionId: string, promptId: string) => QueuedPrompt | null
  clearQueuedPrompts: (sessionId: string) => QueuedPrompt[]
  archiveSession: (sessionId: string, archive: boolean) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  restoreSession: (sessionId: string) => Promise<void>
}

export const createSessionSlice: StateCreator<ChatState, [], [], SessionSlice> = (set, get) => ({
  sessions: [],
  activeSessionId: null,

  loadSessions: async () => {
    try {
      const sessions = await desktopApi.session.list()
      if (sessions.length > 0) {
        set({ sessions: sessions.map((session) => normalizeSession(session)) })
      }
    } catch (err) {
      console.error('[sessionSlice.loadSessions] Failed:', err)
    }
  },

  createSession: (projectId: string) => {
    const id = genId()
    _selectSessionSeq += 1
    const session: ChatSession = {
      id,
      projectId,
      summary: '新会话',
      relativeTime: '刚刚',
      messages: [],
      todos: [],
      queuedPrompts: []
    }
    set((s) => ({
      sessions: [session, ...s.sessions],
      activeSessionId: id,
      messages: [],
      todos: [],
      expandedCapsule: s.expandedCapsule === 'todo' ? null : s.expandedCapsule
    }))
    get().persistCurrentSession()
    return id
  },

  selectSession: async (sessionId: string) => {
    const seq = ++_selectSessionSeq
    // 优先从主进程获取最新数据，避免使用内存中的旧快照
    try {
      const runtimeStatusPromise = desktopApi.chat.getRuntimeStatus(sessionId).catch((error) => {
        console.warn(
          '[sessionSlice.selectSession] Runtime status unavailable; restoring as interrupted:',
          error
        )
        return inactiveRuntimeStatus(sessionId)
      })
      const [freshSession, runtimeStatus] = await Promise.all([
        desktopApi.session.get(sessionId),
        runtimeStatusPromise
      ])
      // 防止竞态：IPC 返回时用户可能已切换到其他会话
      if (seq !== _selectSessionSeq) return
      if (freshSession) {
        const runtimeActive = runtimeStatus.mainRunnerActive || Boolean(get().streamCleanups[sessionId])
        const cachedSession = get().sessions.find((session) => session.id === sessionId)
        const freshMessages = freshSession.messages.map((message) => normalizeMessage(message as ChatMessage))
        const cachedMessages = cachedSession?.messages.map(normalizeMessage) || []
        const sourceMessages = cachedSession && runtimeActive ? cachedMessages : freshMessages
        const healed = runtimeActive
          ? { messages: sourceMessages, changed: false }
          : healInterruptedMessages(sourceMessages)
        const interruptedRequests = interruptPendingRequests(healed.messages, runtimeStatus)
        const normalizedFreshSession = normalizeSession(freshSession)
        const healedSession: ChatSession = {
          ...normalizedFreshSession,
          messages: interruptedRequests.messages,
          queuedPrompts: normalizedFreshSession.queuedPrompts
        }
        set((s) => {
          const sessions = s.sessions.map((sess) =>
            sess.id === sessionId ? { ...sess, ...healedSession, messages: healedSession.messages } : sess
          )
          return {
            sessions,
            activeSessionId: sessionId,
            messages: healedSession.messages,
            todos: healedSession.todos || [],
            expandedCapsule: hasUnfinishedTodos(healedSession.todos)
              ? 'todo'
              : s.expandedCapsule === 'todo'
                ? null
                : s.expandedCapsule,
            pendingInternalContinuation: null,
            activePlan: null
          }
        })
        if (healed.changed || interruptedRequests.changed) {
          await desktopApi.session.save(persistedSession(healedSession))
        }
        return
      }
    } catch (err) {
      console.error('[sessionSlice.selectSession] Failed to load from disk:', err)
    }

    if (seq !== _selectSessionSeq) return

    // Fallback: 从内存中查找
    const session = get().sessions.find((s) => s.id === sessionId)
    if (session) {
      const messages = session.messages.map(normalizeMessage)
      set((s) => ({
        sessions: s.sessions.map((item) => item.id === sessionId
          ? { ...item, messages }
          : item),
        activeSessionId: sessionId,
        messages,
        todos: session.todos || [],
        expandedCapsule: hasUnfinishedTodos(session.todos)
          ? 'todo'
          : s.expandedCapsule === 'todo'
            ? null
            : s.expandedCapsule,
        pendingInternalContinuation: null,
        activePlan: null
      }))
    }
  },

  linkPlanToSession: async () => undefined,

  persistCurrentSession: async () => {
    const { sessions, activeSessionId } = get()
    const session = sessions.find((s) => s.id === activeSessionId)
    if (session) {
      try {
        await desktopApi.session.save(persistedSession(session))
      } catch (err) {
        console.error('[sessionSlice.persistCurrentSession] Failed:', err)
      }
    }
  },

  persistSession: async (sessionId: string) => {
    const { sessions } = get()
    const session = sessions.find((s) => s.id === sessionId)
    if (session) {
      try {
        await desktopApi.session.save(persistedSession(session))
      } catch (err) {
        console.error('[sessionSlice.persistSession] Failed:', err)
      }
    }
  },

  enqueueQueuedPrompt: (sessionId, input) => {
    const prompt: QueuedPrompt = {
      ...input,
      id: `queued_${genId()}`,
      attachments: input.attachments.map((attachment) => ({ ...attachment })),
      createdAt: Date.now(),
      status: 'queued'
    }
    set((state) => ({
      sessions: state.sessions.map((session) => session.id === sessionId
        ? { ...session, queuedPrompts: [...(session.queuedPrompts || []), prompt] }
        : session)
    }))
    void get().persistSession(sessionId)
    return prompt
  },

  updateQueuedPrompt: (sessionId, promptId, patch) => {
    let updated: QueuedPrompt | null = null
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session
        return {
          ...session,
          queuedPrompts: (session.queuedPrompts || []).map((prompt) => {
            if (prompt.id !== promptId) return prompt
            updated = {
              ...prompt,
              ...patch,
              attachments: patch.attachments
                ? patch.attachments.map((attachment) => ({ ...attachment }))
                : prompt.attachments
            }
            return updated
          })
        }
      })
    }))
    if (updated) void get().persistSession(sessionId)
    return updated
  },

  removeQueuedPrompt: (sessionId, promptId) => {
    let removed: QueuedPrompt | null = null
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session
        return {
          ...session,
          queuedPrompts: (session.queuedPrompts || []).filter((prompt) => {
            if (prompt.id !== promptId) return true
            removed = prompt
            return false
          })
        }
      })
    }))
    if (removed) void get().persistSession(sessionId)
    return removed
  },

  clearQueuedPrompts: (sessionId) => {
    let removed: QueuedPrompt[] = []
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session
        removed = session.queuedPrompts || []
        return { ...session, queuedPrompts: [] }
      })
    }))
    if (removed.length > 0) void get().persistSession(sessionId)
    return removed
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
        await desktopApi.session.save(persistedSession(session))
      } catch (err) {
        console.error('[sessionSlice] persist failed:', err)
      }
    }
  },

  deleteSession: async (sessionId: string) => {
    // 如果该会话有活跃流，先停止
    const activeCleanup = get().streamCleanups[sessionId]
    if (activeCleanup) {
      activeCleanup()
      get().setStreamCleanup(sessionId, null)
    }

    const beforeDelete = get()
    const previousSessionIndex = beforeDelete.sessions.findIndex((session) => session.id === sessionId)
    const previousSession = beforeDelete.sessions[previousSessionIndex]
    const previousActiveSessionId = beforeDelete.activeSessionId
    const previousMessages = previousActiveSessionId === sessionId ? beforeDelete.messages : null
    const previousComposerDraft = beforeDelete.composerDrafts[sessionId]
    let isAlreadyDeleted = false
    set((s) => {
      const session = s.sessions.find((x) => x.id === sessionId)
      isAlreadyDeleted = !!session?.isDeleted

      let newSessions: ChatSession[]
      if (isAlreadyDeleted) {
        newSessions = s.sessions.filter((x) => x.id !== sessionId)
      } else {
        newSessions = s.sessions.map((x) =>
          x.id === sessionId ? { ...x, isDeleted: true, deletedAt: Date.now() } : x
        )
      }

      const composerDrafts = { ...s.composerDrafts }
      if (isAlreadyDeleted) delete composerDrafts[sessionId]

      return {
        sessions: newSessions,
        composerDrafts,
        activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
        messages: s.activeSessionId === sessionId ? [] : s.messages
      }
    })
    get().clearRuntimeStatus(sessionId)
    try {
      await desktopApi.session.delete(sessionId)
    } catch (err) {
      get().allowRuntimeStatus(sessionId)
      if (previousSession) {
        set((state) => {
          const sessions = [...state.sessions]
          const currentIndex = sessions.findIndex((session) => session.id === sessionId)
          if (isAlreadyDeleted) {
            if (currentIndex === -1) {
              sessions.splice(Math.min(previousSessionIndex, sessions.length), 0, previousSession)
            }
          } else if (currentIndex >= 0 && sessions[currentIndex].isDeleted) {
            const current = sessions[currentIndex]
            sessions[currentIndex] = {
              ...current,
              isDeleted: previousSession.isDeleted,
              deletedAt: previousSession.deletedAt
            }
          }

          const composerDrafts = { ...state.composerDrafts }
          if (previousComposerDraft && composerDrafts[sessionId] === undefined) {
            composerDrafts[sessionId] = previousComposerDraft
          }
          const restoreActiveSession =
            previousActiveSessionId === sessionId && state.activeSessionId === null
          return {
            sessions,
            composerDrafts,
            activeSessionId: restoreActiveSession ? sessionId : state.activeSessionId,
            messages: restoreActiveSession && previousMessages ? previousMessages : state.messages
          }
        })
      }
      console.error('[sessionSlice.deleteSession] Failed:', err)
    }
  },

  restoreSession: async (sessionId: string) => {
    get().allowRuntimeStatus(sessionId)
    set((s) => {
      const newSessions = s.sessions.map((session) =>
        session.id === sessionId ? { ...session, isDeleted: false, deletedAt: undefined } : session
      )
      return { sessions: newSessions }
    })
    const session = get().sessions.find((s) => s.id === sessionId)
    if (session) {
      try {
        await desktopApi.session.save(persistedSession(session))
      } catch (err) {
        console.error('[sessionSlice] persist failed:', err)
      }
    }
  }
})
