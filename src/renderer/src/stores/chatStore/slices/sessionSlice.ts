import type { StateCreator } from 'zustand'
import type { ChatMessage, ChatState, ChatSession } from '../types'
import { useWorkspaceStore } from '../../workspaceStore'

function genId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// 防竞态：每次 selectSession 分配递增序号，IPC 返回时检查是否仍是最新请求
let _selectSessionSeq = 0

function hasUnfinishedTasks(tasks: Array<{ status: string }> | undefined): boolean {
  return Boolean(tasks?.some((task) => task.status === 'pending' || task.status === 'in_progress'))
}

const normalizeMessage = (message: ChatMessage): ChatMessage => ({
  ...message,
  attachments: Array.isArray(message.attachments)
    ? message.attachments.map((attachment) => ({ ...attachment }))
    : undefined
})

function normalizeSession(session: ChatSession): ChatSession {
  return {
    ...session,
    messages: Array.isArray(session.messages) ? session.messages.map(normalizeMessage) : []
  }
}

function buildSubAgentInterruptedContinuation(subAgents: any[]): string {
  const resumable = subAgents
    .filter((sub) => sub?.status === 'interrupted' && typeof sub.id === 'string')
    .map((sub) => ({
      resume_subagent_id: sub.id,
      subagent_type: sub.type,
      description: sub.description,
      prompt: sub.prompt,
      context: sub.context,
      scope: sub.scope,
      depth: sub.depth,
      expectations: sub.expectations
    }))
  return [
    'The SubAgentRunner calls below were interrupted because their runtime disappeared.',
    'Resume each one with SubAgentRunner using the exact resume_subagent_id, type, prompt, and other arguments shown.',
    'Do not restart, re-plan, re-inspect completed work, or replace the SubAgent unless resume itself returns an error.',
    'Continue the existing user request after the resumed SubAgent finishes.',
    JSON.stringify(resumable)
  ].join(' ')
}

export function interruptPendingRequests(
  messages: ChatMessage[],
  runtimeStatus: { sessionId: string; mainRunnerActive: boolean; activeSubAgentIds: string[] }
): { messages: ChatMessage[]; changed: boolean } {
  if (runtimeStatus.mainRunnerActive || runtimeStatus.activeSubAgentIds.length > 0) {
    return { messages, changed: false }
  }

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

function healInterruptedSubAgents(messages: any[]): {
  messages: any[]
  changed: boolean
  continuationText?: string
} {
  let changed = false
  const healedMessages = messages.map((message) => {
    const subAgents = message.subAgents
    if (!Array.isArray(subAgents) || !subAgents.some((sub: any) => sub.status === 'running')) {
      if (!message.streaming) return message
      changed = true
      return { ...message, streaming: false, interrupted: true }
    }

    changed = true
    const healedSubAgents = subAgents.map((sub: any) => {
      if (sub.status !== 'running') return sub
      return {
        ...sub,
        status: 'interrupted',
        interruptionReason: 'runtime_missing',
        completedAt: sub.completedAt || Date.now()
      }
    })
    return {
      ...message,
      streaming: false,
      interrupted: true,
      subAgents: healedSubAgents
    }
  })

  const latestById = new Map<string, any>()
  for (const message of healedMessages) {
    for (const subAgent of message.subAgents || []) {
      if (typeof subAgent?.id === 'string') latestById.set(subAgent.id, subAgent)
    }
  }
  const resumableSubAgents = Array.from(latestById.values()).filter((subAgent) =>
    subAgent.status === 'interrupted' && subAgent.interruptionReason === 'runtime_missing'
  )

  return {
    messages: healedMessages,
    changed,
    continuationText: resumableSubAgents.length > 0
      ? buildSubAgentInterruptedContinuation(resumableSubAgents)
      : undefined
  }
}

function hasNewerSettledSubAgent(messagesFromDisk: any[], messagesInMemory: any[]): boolean {
  const settledIds = new Set<string>()
  for (const message of messagesInMemory) {
    for (const subAgent of message.subAgents || []) {
      if (subAgent.status !== 'running') settledIds.add(subAgent.id)
    }
  }
  return messagesFromDisk.some((message) =>
    message.subAgents?.some((subAgent: any) =>
      subAgent.status === 'running' && settledIds.has(subAgent.id)
    )
  )
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
  archiveSession: (sessionId: string, archive: boolean) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  restoreSession: (sessionId: string) => Promise<void>
}

export const createSessionSlice: StateCreator<ChatState, [], [], SessionSlice> = (set, get) => ({
  sessions: [],
  activeSessionId: null,

  loadSessions: async () => {
    try {
      const sessions = await window.api.session.list()
      if (Array.isArray(sessions) && sessions.length > 0) {
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
      tasks: []
    }
    set((s) => ({
      sessions: [session, ...s.sessions],
      activeSessionId: id,
      messages: [],
      tasks: [],
      expandedCapsule: s.expandedCapsule === 'task' ? null : s.expandedCapsule
    }))
    get().persistCurrentSession()
    return id
  },

  selectSession: async (sessionId: string) => {
    const seq = ++_selectSessionSeq
    // 优先从主进程获取最新数据，避免使用内存中的旧快照
    try {
      const runtimeStatusPromise = window.api.chat?.getRuntimeStatus
        ? window.api.chat.getRuntimeStatus(sessionId)
        : Promise.resolve({
            sessionId,
            mainRunnerActive: true,
            activeSubAgentIds: []
          })
      const [freshSession, runtimeStatus] = await Promise.all([
        window.api.session.get(sessionId),
        runtimeStatusPromise
      ])
      // 防止竞态：IPC 返回时用户可能已切换到其他会话
      if (seq !== _selectSessionSeq) return
      if (freshSession) {
        const runtimeActive = runtimeStatus.mainRunnerActive ||
          runtimeStatus.activeSubAgentIds.length > 0 ||
          Boolean(get().streamCleanups[sessionId])
        const cachedSession = get().sessions.find((session) => session.id === sessionId)
        const freshMessages = Array.isArray(freshSession.messages)
          ? freshSession.messages.map(normalizeMessage)
          : []
        const cachedMessages = cachedSession?.messages.map(normalizeMessage) || []
        const memoryHasNewerTerminalState = Boolean(cachedSession) &&
          hasNewerSettledSubAgent(freshMessages, cachedMessages)
        const sourceMessages = cachedSession && (runtimeActive || memoryHasNewerTerminalState)
          ? cachedMessages
          : freshMessages
        const healed = runtimeActive
          ? { messages: sourceMessages, changed: false, continuationText: undefined }
          : healInterruptedSubAgents(sourceMessages)
        const interruptedRequests = interruptPendingRequests(healed.messages, runtimeStatus)
        const healedSession = {
          ...freshSession,
          messages: interruptedRequests.messages
        }
        set((s) => {
          const sessions = s.sessions.map((sess) =>
            sess.id === sessionId ? { ...sess, ...healedSession, messages: healedSession.messages } : sess
          )
          return {
            sessions,
            activeSessionId: sessionId,
            messages: healedSession.messages,
            tasks: freshSession.tasks || [],
            expandedCapsule: hasUnfinishedTasks(freshSession.tasks)
              ? 'task'
              : s.expandedCapsule === 'task'
                ? null
                : s.expandedCapsule,
            pendingInternalContinuation: null,
            activePlan: null
          }
        })
        if (healed.changed || interruptedRequests.changed) {
          await window.api.session.save(healedSession)
        }
        if (healed.continuationText && seq === _selectSessionSeq && get().activeSessionId === sessionId) {
          set({
            pendingInternalContinuation: {
              sessionId,
              text: healed.continuationText
            }
          })
        }
        if (freshSession.linkedPlanSlug) {
          try {
            const workspace = useWorkspaceStore.getState().workspace
            if (workspace) {
              const plan = await (window as any).api.plan.load(workspace.rootPath, freshSession.linkedPlanSlug)
              if (get().activeSessionId === sessionId) {
                set({ activePlan: plan })
              }
            }
          } catch {
            // ignore
          }
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
        tasks: (session as any).tasks || [],
        expandedCapsule: hasUnfinishedTasks((session as any).tasks)
          ? 'task'
          : s.expandedCapsule === 'task'
            ? null
            : s.expandedCapsule,
        pendingInternalContinuation: null,
        activePlan: null
      }))
      if (session.linkedPlanSlug) {
        try {
          const workspace = useWorkspaceStore.getState().workspace
          if (workspace) {
            const plan = await (window as any).api.plan.load(workspace.rootPath, session.linkedPlanSlug)
            if (get().activeSessionId === sessionId) {
              set({ activePlan: plan })
            }
          }
        } catch {
          // ignore
        }
      }
    }
  },

  linkPlanToSession: async (sessionId: string, planSlug: string | null) => {
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId ? { ...sess, linkedPlanSlug: planSlug || undefined } : sess
      )
    }))
    if (get().activeSessionId === sessionId) {
      if (!planSlug) {
        set({ activePlan: null })
      } else {
        try {
          const workspace = useWorkspaceStore.getState().workspace
          if (workspace) {
            const plan = await (window as any).api.plan.load(workspace.rootPath, planSlug)
            set({ activePlan: plan })
          }
        } catch {
          // ignore
        }
      }
      await get().persistCurrentSession()
    }
  },

  persistCurrentSession: async () => {
    const { sessions, activeSessionId } = get()
    const session = sessions.find((s) => s.id === activeSessionId)
    if (session) {
      try {
        await window.api.session.save(session)
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
        await window.api.session.save(session)
      } catch (err) {
        console.error('[sessionSlice.persistSession] Failed:', err)
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

      return {
        sessions: newSessions,
        activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
        messages: s.activeSessionId === sessionId ? [] : s.messages
      }
    })
    get().clearRuntimeStatus(sessionId)
    try {
      await window.api.session.delete(sessionId)
    } catch (err) {
      get().allowRuntimeStatus(sessionId)
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
        await window.api.session.save(session)
      } catch (err) {
        console.error('[sessionSlice] persist failed:', err)
      }
    }
  }
})
