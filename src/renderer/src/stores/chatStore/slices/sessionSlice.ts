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

function buildInterruptedSubAgentPrompt(subAgent: any): string {
  const description = subAgent.description || subAgent.type || '未命名子智能体任务'
  const prompt = subAgent.prompt || subAgent.description || ''
  const partial = subAgent.content?.trim()
  return [
    `继续刚才中断的子智能体任务：${description}`,
    prompt ? `原始任务：${prompt}` : '',
    partial ? `已产生的部分结果：${partial}` : '',
    '请先基于当前会话里已有的执行记录判断已完成内容，再继续未完成分析。'
  ].filter(Boolean).join('\n\n')
}

function healInterruptedSubAgents(messages: any[]): { messages: any[]; prompt: string | null; changed: boolean } {
  let prompt: string | null = null
  let changed = false
  const healedMessages = messages.map((message) => {
    const subAgents = message.subAgents
    if (!Array.isArray(subAgents) || !subAgents.some((sub: any) => sub.status === 'running')) {
      return message.streaming ? { ...message, streaming: false, interrupted: true } : message
    }

    changed = true
    const healedSubAgents = subAgents.map((sub: any) => {
      if (sub.status !== 'running') return sub
      if (!prompt) prompt = buildInterruptedSubAgentPrompt(sub)
      return {
        ...sub,
        status: 'interrupted',
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

  return { messages: healedMessages, prompt, changed }
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
        // 愈合崩溃残留：将 streaming:true 的消息标记为 interrupted
        const healedSessions = sessions.map((session) => {
          const normalized = normalizeSession(session)
          return {
            ...normalized,
            messages: healInterruptedSubAgents(normalized.messages).messages
          }
        })
        set({ sessions: healedSessions })
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
      const freshSession = await window.api.session.get(sessionId)
      // 防止竞态：IPC 返回时用户可能已切换到其他会话
      if (seq !== _selectSessionSeq) return
      if (freshSession) {
        const normalizedSession = normalizeSession(freshSession)
        const healed = healInterruptedSubAgents(normalizedSession.messages)
        const healedSession = {
          ...normalizedSession,
          messages: healed.messages
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
            pendingPrompt: healed.prompt ? { text: healed.prompt, attachments: [] } : s.pendingPrompt,
            activePlan: null
          }
        })
        if (healed.changed) {
          await window.api.session.save(healedSession)
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
      const normalizedSession = normalizeSession(session)
      const healed = healInterruptedSubAgents(normalizedSession.messages)
      set((s) => ({
        activeSessionId: sessionId,
        messages: healed.messages,
        tasks: (session as any).tasks || [],
        expandedCapsule: hasUnfinishedTasks((session as any).tasks)
          ? 'task'
          : s.expandedCapsule === 'task'
            ? null
            : s.expandedCapsule,
        pendingPrompt: healed.prompt ? { text: healed.prompt, attachments: [] } : s.pendingPrompt,
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
    try {
      await window.api.session.delete(sessionId)
    } catch (err) {
      console.error('[sessionSlice.deleteSession] Failed:', err)
    }
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
      } catch (err) {
        console.error('[sessionSlice] persist failed:', err)
      }
    }
  }
})
