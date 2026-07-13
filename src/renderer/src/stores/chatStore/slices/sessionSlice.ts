import type { StateCreator } from 'zustand'
import type { ChatMessage, ChatState, ChatSession } from '../types'
import { useWorkspaceStore } from '../../workspaceStore'
import type {
  SessionRuntimeStatus,
  SubAgentHandoff,
  SubAgentHandoffTool
} from '../../../../../shared/types/subagent'
import type { QueuedPrompt } from '../../../../../shared/types/queuedPrompt'

function genId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// 防竞态：每次 selectSession 分配递增序号，IPC 返回时检查是否仍是最新请求
let _selectSessionSeq = 0

function hasUnfinishedTasks(tasks: Array<{ status: string }> | undefined): boolean {
  return Boolean(tasks?.some((task) => task.status === 'pending' || task.status === 'in_progress'))
}

function inactiveRuntimeStatus(sessionId: string): SessionRuntimeStatus {
  return { sessionId, mainRunnerActive: false, activeSubAgentIds: [] }
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
    messages: Array.isArray(session.messages) ? session.messages.map(normalizeMessage) : [],
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

function truncateHandoffText(value: string, maxLength: number): string {
  const normalized = value.trim()
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength)}\n...[truncated]`
}

function toolTarget(name: string, rawArgs: string): string | undefined {
  try {
    const args = JSON.parse(rawArgs || '{}')
    const direct = args.file_path || args.notebook_path || args.path || args.command || args.commandLine
    if (typeof direct === 'string' && direct.trim()) return truncateHandoffText(direct, 240)
    if (name === 'Read' && Array.isArray(args.files)) {
      const paths = args.files.map((file: any) => file?.file_path).filter(Boolean)
      if (paths.length > 0) return truncateHandoffText(paths.join(', '), 240)
    }
  } catch {}
  return undefined
}

function toolResultSummary(rawResult: string | undefined): string | undefined {
  if (!rawResult?.trim()) return undefined
  try {
    const parsed = JSON.parse(rawResult)
    const value = parsed?.ok === false
      ? parsed.error?.message || parsed.error
      : parsed?.data
    if (value === undefined) return undefined
    return truncateHandoffText(
      typeof value === 'string' ? value : JSON.stringify(value),
      400
    )
  } catch {
    return truncateHandoffText(rawResult, 400)
  }
}

function hasWrappedToolError(rawResult: string | undefined): boolean {
  if (!rawResult?.trim()) return false
  try {
    const parsed = JSON.parse(rawResult)
    return parsed?.ok === false ||
      (typeof parsed?.data === 'string' && parsed.data.trimStart().startsWith('Error:')) ||
      Boolean(parsed?.error && !parsed?.data)
  } catch {
    return rawResult.trimStart().startsWith('Error:')
  }
}

function buildRecoveredSubAgentHandoff(
  subAgent: any,
  reasonCode: 'runtime_missing' | 'parent_delivery_missing' = 'runtime_missing'
): SubAgentHandoff {
  const tools: SubAgentHandoffTool[] = (subAgent.toolCalls || []).slice(-8).map((tool: any) => ({
    name: tool.name,
    status: tool.status === 'running'
      ? 'interrupted'
      : tool.status === 'success' && hasWrappedToolError(tool.result)
        ? 'error'
        : tool.status,
    target: toolTarget(tool.name, tool.args),
    summary: toolResultSummary(tool.result)
  }))
  const successfulTools = tools.filter((tool) => tool.status === 'success')
  const filesModified = successfulTools
    .filter((tool) => ['Edit', 'Write', 'NotebookEdit'].includes(tool.name) && tool.target)
    .map((tool) => tool.target!)
  const filesPossiblyModified = tools
    .filter((tool) =>
      tool.status === 'interrupted' &&
      ['Edit', 'Write', 'NotebookEdit'].includes(tool.name) &&
      tool.target
    )
    .map((tool) => tool.target!)
  const filesExamined = new Set<string>(subAgent.result?.filesExamined || [])
  for (const tool of successfulTools) {
    if (['Read', 'list_files'].includes(tool.name) && tool.target) filesExamined.add(tool.target)
  }
  return {
    reasonCode,
    reason: reasonCode === 'parent_delivery_missing'
      ? 'The SubAgent reached a terminal state, but its result may not have been delivered to the parent Agent before the runtime disappeared.'
      : 'The SubAgent runtime disappeared before its result was delivered to the parent Agent.',
    originalTask: truncateHandoffText(subAgent.prompt || '', 2500),
    knownContext: subAgent.context
      ? truncateHandoffText(subAgent.context, 1200)
      : undefined,
    scope: subAgent.scope
      ? {
          directories: subAgent.scope.directories?.slice(0, 10).map((value: string) =>
            truncateHandoffText(value, 160)
          ),
          excludeGlobs: subAgent.scope.excludeGlobs?.slice(0, 10).map((value: string) =>
            truncateHandoffText(value, 160)
          )
        }
      : undefined,
    expectations: subAgent.expectations
      ? {
          questions: subAgent.expectations.questions.slice(0, 12).map((value: string) =>
            truncateHandoffText(value, 240)
          ),
          outOfScope: subAgent.expectations.outOfScope?.slice(0, 8).map((value: string) =>
            truncateHandoffText(value, 240)
          )
        }
      : undefined,
    depth: subAgent.depth,
    lastProgress: subAgent.content
      ? truncateHandoffText(subAgent.content, 1500)
      : undefined,
    filesExamined: Array.from(filesExamined).slice(-20).map((value) =>
      truncateHandoffText(value, 240)
    ),
    filesModified: Array.from(new Set(filesModified)).slice(-20),
    filesPossiblyModified: Array.from(new Set(filesPossiblyModified)).slice(-20),
    recentTools: tools,
    workspaceMayHaveUntrackedChanges: tools.some((tool) =>
      ['Bash', 'PowerShell'].includes(tool.name) && tool.status !== 'error'
    ),
    canResume: true
  }
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
} {
  let changed = false
  const interruptMessage = (message: any, subAgents = message.subAgents) => ({
    ...message,
    streaming: false,
    streamPhase: undefined,
    responseWaitWarning: undefined,
    interrupted: true,
    executionStatus: 'interrupted',
    ...(Array.isArray(subAgents) ? { subAgents } : {})
  })
  const healedMessages = messages.map((message) => {
    const subAgents = message.subAgents
    if (!Array.isArray(subAgents)) {
      if (!message.streaming) return message
      changed = true
      return interruptMessage(message)
    }

    const hasRunningSubAgent = subAgents.some((sub: any) => sub.status === 'running')
    const hasUndeliveredTerminalSubAgent = Boolean(
      message.streaming && subAgents.some((sub: any) =>
        sub.status === 'completed' || sub.status === 'failed'
      )
    )
    if (!hasRunningSubAgent && !hasUndeliveredTerminalSubAgent) {
      if (!message.streaming) return message
      changed = true
      return interruptMessage(message)
    }

    changed = true
    const healedSubAgents = subAgents.map((sub: any) => {
      if (sub.status === 'running') {
        return {
          ...sub,
          status: 'interrupted',
          interruptionReason: 'runtime_missing',
          completedAt: sub.completedAt || Date.now(),
          result: {
            ...sub.result,
            output: sub.result?.output || 'SubAgent runtime disappeared before completion.',
            toolCallCount: sub.result?.toolCallCount ?? sub.toolCalls?.length ?? 0,
            handoff: sub.result?.handoff || buildRecoveredSubAgentHandoff(sub)
          }
        }
      }
      if (message.streaming && (sub.status === 'completed' || sub.status === 'failed')) {
        return {
          ...sub,
          interruptionReason: 'parent_delivery_missing',
          result: {
            ...sub.result,
            output: sub.result?.output || sub.content || 'SubAgent result delivery was interrupted.',
            toolCallCount: sub.result?.toolCallCount ?? sub.toolCalls?.length ?? 0,
            handoff: sub.result?.handoff || buildRecoveredSubAgentHandoff(
              sub,
              'parent_delivery_missing'
            )
          }
        }
      }
      return sub
    })
    return interruptMessage(message, healedSubAgents)
  })

  return {
    messages: healedMessages,
    changed
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
      tasks: [],
      queuedPrompts: []
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
        ? window.api.chat.getRuntimeStatus(sessionId).catch((error) => {
            console.warn(
              '[sessionSlice.selectSession] Runtime status unavailable; restoring as interrupted:',
              error
            )
            return inactiveRuntimeStatus(sessionId)
          })
        : Promise.resolve(inactiveRuntimeStatus(sessionId))
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
          ? { messages: sourceMessages, changed: false }
          : healInterruptedSubAgents(sourceMessages)
        const interruptedRequests = interruptPendingRequests(healed.messages, runtimeStatus)
        const normalizedFreshSession = normalizeSession(freshSession as ChatSession)
        const healedSession = {
          ...freshSession,
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
