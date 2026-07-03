import type { StateCreator } from 'zustand'
import type { ChatState, ChatSession } from '../types'
import { useWorkspaceStore } from '../../workspaceStore'

function genId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
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

  selectSession: async (sessionId: string) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (session) {
      set({
        activeSessionId: sessionId,
        messages: session.messages,
        activePlan: null
      })
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
      } catch {
        // 静默失败
      }
    }
  },

  persistSession: async (sessionId: string) => {
    const { sessions } = get()
    const session = sessions.find((s) => s.id === sessionId)
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
  }
})
