import type { StateCreator } from 'zustand'
import type {
  ChatState,
  ChatMessage,
  AgentState,
  ToolCallState,
  ToolTimelineItem,
  ReasoningTimelineItem,
  TextTimelineItem,
  SubAgentRecord,
  ChatSession,
  PendingInternalContinuation
} from '../types'
import type { TaskItem } from '../../../../../shared/types/task'
import { IPC_CHANNELS } from '../../../../../shared/ipc/channels'
import type { ImageAttachment, PendingPromptDraft } from '../../../../../shared/types/attachment'
import type { SubAgentHandoff } from '../../../../../shared/types/subagent'
import { setSessionComposerDraft } from '../composerDrafts'

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

let _planStateListenerRefs = 0
let _planStateListenerCleanup: (() => void) | null = null

export interface MessageSlice {
  messages: ChatMessage[]
  streamCleanups: Record<string, (() => void) | null>
  expandedCapsule: 'task' | 'plan' | null
  subAgentStatus: 'idle' | 'running' | 'completed' | 'failed'
  planListModalOpen: boolean
  activePlan: any | null
  planReview: { plan: any; status: string } | null
  activePlanStreamId: string | null
  pendingPrompt: PendingPromptDraft | null
  composerDrafts: Record<string, PendingPromptDraft | undefined>
  pendingInternalContinuation: PendingInternalContinuation | null
  tasks: TaskItem[]

  addUserMessage: (content: string, attachments?: ImageAttachment[]) => ChatMessage
  removeMessages: (messageIds: string[]) => void
  addSystemMessage: (content: string) => ChatMessage
  startStreamingReply: () => string
  appendStreamChunk: (msgId: string, delta: string, reasoningDelta?: string) => void
  finishStreaming: (msgId: string, txId?: string) => void
  setMessageExecutionStatus: (
    msgId: string,
    status: 'completed' | 'error' | 'interrupted'
  ) => void
  setMessageStreamPhase: (msgId: string, phase: 'starting' | 'running') => void
  setResponseWaitWarning: (msgId: string, visible: boolean) => void
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
  startSubAgent: (
    msgId: string,
    subAgentId: string,
    meta: {
      type: string
      description: string
      prompt: string
      depth?: 'quick' | 'normal' | 'exhaustive'
      expectations?: { questions: string[]; outOfScope?: string[] }
      context?: string
      scope?: { directories?: string[]; excludeGlobs?: string[] }
      parentToolCallId: string
    }
  ) => void
  appendSubAgentChunk: (msgId: string, subAgentId: string, delta: string, reasoningDelta: string) => void
  startSubAgentToolCall: (msgId: string, subAgentId: string, toolCall: Omit<ToolCallState, 'status' | 'startedAt' | 'sequence'>) => void
  finishSubAgentToolCall: (msgId: string, subAgentId: string, toolCallId: string, result: string) => void
  endSubAgent: (
    msgId: string,
    subAgentId: string,
    result: { status: 'completed' | 'failed' | 'interrupted'; output?: string; qualitySummary?: any; toolCallCount: number; filesExamined?: string[]; handoff?: SubAgentHandoff }
  ) => void
  setExpandedCapsule: (capsule: 'task' | 'plan' | null) => void
  setSubAgentStatus: (status: 'idle' | 'running' | 'completed' | 'failed') => void
  initPlanStateListener: () => () => void
  setPlanListModalOpen: (open: boolean) => void
  setActivePlan: (plan: any | null) => void
  setPlanReview: (review: { plan: any; status: string } | null) => void
  setActivePlanStreamId: (streamId: string | null) => void
  setPendingPrompt: (prompt: PendingPromptDraft | null) => void
  setComposerDraft: (sessionId: string, draft: PendingPromptDraft) => void
  setPendingInternalContinuation: (continuation: PendingInternalContinuation | null) => void
  consumeInternalContinuation: (sessionId: string) => PendingInternalContinuation | null
  markActiveRunUserAborted: (sessionId: string) => void
  setTasks: (tasks: TaskItem[]) => void
  revertToMessage: (msgId: string) => Promise<void>
  previewRevertMessage: (msgId: string) => Promise<{ toDelete: string[], toRestore: string[] } | null>
}

export function updateMessageInState(
  s: ChatState,
  msgId: string,
  updater: (m: ChatMessage) => ChatMessage,
  sessionUpdater?: (session: ChatSession, updatedMessages: ChatMessage[]) => ChatSession
): Partial<ChatState> {
  const replaceMessage = (messages: ChatMessage[], index: number): ChatMessage[] => {
    const updatedMessage = updater(messages[index])
    if (updatedMessage === messages[index]) return messages
    const updatedMessages = messages.slice()
    updatedMessages[index] = updatedMessage
    return updatedMessages
  }

  // Streaming events overwhelmingly target the active conversation. Resolve that
  // path first so a token does not scan every persisted session and message.
  if (s.activeSessionId) {
    const activeMessageIndex = s.messages.findIndex((message) => message.id === msgId)
    if (activeMessageIndex >= 0) {
      const updatedMessages = replaceMessage(s.messages, activeMessageIndex)
      const activeSessionIndex = s.sessions.findIndex(
        (session) => session.id === s.activeSessionId
      )
      if (activeSessionIndex < 0) return { messages: updatedMessages }

      let updatedSession = {
        ...s.sessions[activeSessionIndex],
        messages: updatedMessages
      }
      if (sessionUpdater) {
        updatedSession = sessionUpdater(updatedSession, updatedMessages)
      }
      const sessions = s.sessions.slice()
      sessions[activeSessionIndex] = updatedSession
      return { messages: updatedMessages, sessions }
    }
  }

  // A background stream can keep running after the user switches sessions.
  for (let sessionIndex = 0; sessionIndex < s.sessions.length; sessionIndex++) {
    const session = s.sessions[sessionIndex]
    const messageIndex = session.messages.findIndex((message) => message.id === msgId)
    if (messageIndex < 0) continue

    const updatedMessages = replaceMessage(session.messages, messageIndex)
    let updatedSession = { ...session, messages: updatedMessages }
    if (sessionUpdater) {
      updatedSession = sessionUpdater(updatedSession, updatedMessages)
    }
    const sessions = s.sessions.slice()
    sessions[sessionIndex] = updatedSession
    return { sessions }
  }

  const messageIndex = s.messages.findIndex((message) => message.id === msgId)
  return messageIndex >= 0 ? { messages: replaceMessage(s.messages, messageIndex) } : {}
}

export function removeMessagesFromState(
  state: ChatState,
  messageIds: Set<string>
): Pick<ChatState, 'messages' | 'sessions'> {
  const messages = state.messages.filter((message) => !messageIds.has(message.id))
  return {
    messages,
    sessions: state.sessions.map((session) => session.id === state.activeSessionId
      ? { ...session, messages }
      : session)
  }
}

/** 在指定消息内更新某个 sub-agent record；未找到时返回原状态（no-op） */
function updateSubAgentInState(
  s: ChatState,
  msgId: string,
  subAgentId: string,
  updater: (sub: SubAgentRecord) => SubAgentRecord
): Partial<ChatState> {
  return updateMessageInState(s, msgId, (m) => {
    const subs = m.subAgents
    if (!subs || !subs.some((sub) => sub.id === subAgentId)) return m
    return {
      ...m,
      subAgents: subs.map((sub) => (sub.id === subAgentId ? updater(sub) : sub))
    }
  })
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
  composerDrafts: {},
  pendingInternalContinuation: null,
  tasks: [],

  addUserMessage: (content: string, attachments?: ImageAttachment[]) => {
    const msg: ChatMessage = {
      id: genId(),
      role: 'user',
      content,
      ...(attachments?.length ? { attachments: attachments.map((item) => ({ ...item })) } : {})
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

  removeMessages: (messageIds: string[]) => {
    const ids = new Set(messageIds)
    set((state) => removeMessagesFromState(state, ids))
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
      streaming: true,
      streamPhase: 'starting'
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
    if (!delta && !reasoningDelta) return
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
          timeline = [
            ...timeline.slice(0, -1),
            { ...last, content: last.content + delta, updatedAt: now }
          ]
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

      if (reasoningDelta) {
        const now = Date.now()
        const last = timeline[timeline.length - 1]
        if (last?.type === 'reasoning') {
          timeline = [
            ...timeline.slice(0, -1),
            { ...last, content: last.content + reasoningDelta, status: 'running', updatedAt: now }
          ]
        } else {
          timeline = [
            ...timeline,
            {
              id: genId(),
              type: 'reasoning',
              content: reasoningDelta,
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
        return { ...m, streaming: false, streamPhase: undefined, txId, executionTimeline: timeline }
      },
      (session, updatedMessages) => ({
        ...session,
        summary: updatedMessages[0]?.content.slice(0, 60) || '新会话',
        relativeTime: '刚刚'
      })
    ))
  },

  setMessageExecutionStatus: (msgId, status) => {
    set((s) => updateMessageInState(s, msgId, (message) => ({
      ...message,
      executionStatus: status
    })))
    void get().persistCurrentSession()
  },

  setMessageStreamPhase: (msgId, phase) => {
    set((s) => updateMessageInState(s, msgId, (message) => ({
      ...message,
      streamPhase: phase
    })))
  },

  setResponseWaitWarning: (msgId, visible) => {
    set((s) => updateMessageInState(s, msgId, (message) => ({
      ...message,
      responseWaitWarning: visible || undefined
    })))
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
          executionTimeline: [
            ...timeline.slice(0, -1),
            { ...last, content: last.content + delta, status: 'running', updatedAt: now }
          ]
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
      const isTextAskFallback = toolCall.textAskUserFallback === true
      const timeline = isTextAskFallback
        ? (m.executionTimeline || []).filter((item) => item.type !== 'text')
        : m.executionTimeline || []
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
                  thoughtSignature: toolCall.thoughtSignature || item.thoughtSignature,
                  batchId: toolCall.batchId ?? item.batchId,
                  batchIndex: toolCall.batchIndex ?? item.batchIndex,
                  batchSize: toolCall.batchSize ?? item.batchSize
                }
              : item
          ),
          executionTimeline: timeline.map((item) =>
            item.id === 'tool_' + toolCall.id && item.type === 'tool'
              ? {
                  ...item,
                  toolCall: {
                    ...item.toolCall,
                    name: toolCall.name,
                    args: toolCall.args,
                    batchId: toolCall.batchId ?? item.toolCall.batchId,
                    batchIndex: toolCall.batchIndex ?? item.toolCall.batchIndex,
                    batchSize: toolCall.batchSize ?? item.toolCall.batchSize
                  },
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
        ...(isTextAskFallback ? { content: '' } : {}),
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
          const rawDataError = typeof parsed?.data === 'string' &&
            parsed.data.trimStart().startsWith('Error:')
          hasStructuredError = parsed?.ok === false || rawDataError || Boolean(parsed?.error && !parsed?.data)
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

  startSubAgent: (msgId, subAgentId, meta) => {
    set((s) => updateMessageInState(s, msgId, (m) => {
      const existing = m.subAgents || []
      if (existing.some((sub) => sub.id === subAgentId)) return m
      const now = Date.now()
      const record: SubAgentRecord = {
        id: subAgentId,
        type: meta.type,
        description: meta.description,
        prompt: meta.prompt,
        depth: meta.depth,
        expectations: meta.expectations,
        context: meta.context,
        scope: meta.scope,
        parentToolCallId: meta.parentToolCallId,
        status: 'running',
        startedAt: now,
        content: '',
        toolCalls: [],
        executionTimeline: []
      }
      return { ...m, subAgents: [...existing, record] }
    }))
    schedulePersist(get)
  },

  appendSubAgentChunk: (msgId, subAgentId, delta, reasoningDelta) => {
    if (!delta && !reasoningDelta) return
    set((s) => updateSubAgentInState(s, msgId, subAgentId, (sub) => {
      const now = Date.now()
      let timeline = sub.executionTimeline
      let content = sub.content
      let reasoningContent = sub.reasoningContent

      if (delta) {
        content = sub.content + delta
        const last = timeline[timeline.length - 1]
        if (last?.type === 'text') {
          timeline = [
            ...timeline.slice(0, -1),
            { ...last, content: last.content + delta, updatedAt: now }
          ]
        } else {
          timeline = [...timeline, {
            id: genId(),
            type: 'text',
            content: delta,
            status: 'running',
            startedAt: now,
            updatedAt: now,
            sequence: timeline.length
          } as TextTimelineItem]
        }
      }

      if (reasoningDelta) {
        reasoningContent = sub.reasoningContent
          ? sub.reasoningContent + reasoningDelta
          : reasoningDelta
        const last = timeline[timeline.length - 1]
        if (last?.type === 'reasoning') {
          timeline = [
            ...timeline.slice(0, -1),
            { ...last, content: last.content + reasoningDelta, status: 'running', updatedAt: now }
          ]
        } else {
          timeline = [...timeline, {
            id: genId(),
            type: 'reasoning',
            content: reasoningDelta,
            status: 'running',
            startedAt: now,
            updatedAt: now,
            sequence: timeline.length
          } as ReasoningTimelineItem]
        }
      }

      return { ...sub, content, reasoningContent, executionTimeline: timeline }
    }))
    schedulePersist(get)
  },

  startSubAgentToolCall: (msgId, subAgentId, toolCall) => {
    set((s) => updateSubAgentInState(s, msgId, subAgentId, (sub) => {
      const existing = sub.toolCalls
      const timeline = sub.executionTimeline
      const now = Date.now()

      if (existing.some((item) => item.id === toolCall.id)) {
        return {
          ...sub,
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
        ...sub,
        toolCalls: [...existing, nextToolCall].sort((a, b) => a.sequence - b.sequence),
        executionTimeline: [...timeline, nextTimelineItem].sort((a, b) => a.sequence - b.sequence)
      }
    }))
    schedulePersist(get)
  },

  finishSubAgentToolCall: (msgId, subAgentId, toolCallId, result) => {
    set((s) => updateSubAgentInState(s, msgId, subAgentId, (sub) => {
      const now = Date.now()
      const updateToolCall = (toolCall: ToolCallState): ToolCallState => {
        if (toolCall.id !== toolCallId) return toolCall
        let hasStructuredError = false
        try {
          const parsed = JSON.parse(result)
          const rawDataError = typeof parsed?.data === 'string' &&
            parsed.data.trimStart().startsWith('Error:')
          hasStructuredError = parsed?.ok === false || rawDataError || Boolean(parsed?.error && !parsed?.data)
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
      return {
        ...sub,
        toolCalls: sub.toolCalls.map(updateToolCall),
        executionTimeline: sub.executionTimeline.map((item) =>
          item.type === 'tool' && item.toolCall.id === toolCallId
            ? { ...item, toolCall: updateToolCall(item.toolCall), updatedAt: now }
            : item
        )
      }
    }))
    schedulePersist(get)
  },

  endSubAgent: (msgId, subAgentId, result) => {
    set((s) => updateSubAgentInState(s, msgId, subAgentId, (sub) => {
      const now = Date.now()
      const timeline = sub.executionTimeline.map((item) => {
        if (item.type === 'text' && item.status === 'running') {
          return { ...item, status: 'success' as const, completedAt: now, updatedAt: now }
        }
        if (item.type === 'reasoning' && item.status === 'running') {
          return { ...item, status: 'success' as const, updatedAt: now, completedAt: now }
        }
        return item
      })
      return {
        ...sub,
        status: result.status,
        completedAt: now,
        executionTimeline: timeline,
        result: {
          output: result.output,
          qualitySummary: result.qualitySummary,
          toolCallCount: result.toolCallCount,
          filesExamined: result.filesExamined,
          handoff: result.handoff
        }
      }
    }))
    schedulePersist(get)
  },

  setExpandedCapsule: (capsule) => set({ expandedCapsule: capsule }),
  setSubAgentStatus: (status) => set({ subAgentStatus: status }),

  initPlanStateListener: () => {
    let released = false
    const release = () => {
      if (released) return
      released = true
      _planStateListenerRefs = Math.max(0, _planStateListenerRefs - 1)
      if (_planStateListenerRefs === 0) {
        _planStateListenerCleanup?.()
        _planStateListenerCleanup = null
      }
    }

    _planStateListenerRefs += 1
    if (_planStateListenerCleanup) return release

    const win = window as any
    const ipc = win?.electron?.ipcRenderer
    if (!ipc) {
      _planStateListenerRefs -= 1
      return () => {}
    }

    const subAgentProgressHandler = (
      _event: unknown,
      data: { status: 'idle' | 'running' | 'completed' | 'failed' }
    ) => {
      get().setSubAgentStatus(data.status)
    }
    const reviewRequestHandler = (_event: unknown, streamId: string, plan: any) => {
      get().setActivePlanStreamId(streamId)
      get().setPlanReview({ plan, status: 'pending_review' })
    }
    const stateChangedHandler = (_event: unknown, plan: any) => {
      get().setActivePlan(plan)
    }
    const linkedHandler = (_event: unknown, data: { sessionId: string; plan: any }) => {
      get().linkPlanToSession(data.sessionId, data.plan.slug)
      get().setActivePlan(data.plan)
    }

    const listeners: Array<[string, (...args: any[]) => void]> = [
      ['plan:subagent-progress', subAgentProgressHandler],
      ['plan:review-request', reviewRequestHandler],
      ['plan:state-changed', stateChangedHandler],
      ['plan:linked', linkedHandler]
    ]
    listeners.forEach(([channel, handler]) => ipc.on(channel, handler))
    _planStateListenerCleanup = () => {
      listeners.forEach(([channel, handler]) => ipc.removeListener?.(channel, handler))
    }
    return release
  },

  setPlanListModalOpen: (open) => set({ planListModalOpen: open }),
  setActivePlan: (plan) => set({ activePlan: plan }),
  setPlanReview: (review) => set({ planReview: review }),
  setActivePlanStreamId: (streamId) => set({ activePlanStreamId: streamId }),
  setPendingPrompt: (prompt) => set({ pendingPrompt: prompt }),
  setComposerDraft: (sessionId, draft) => set((state) => ({
    composerDrafts: setSessionComposerDraft(state.composerDrafts, sessionId, draft)
  })),
  setPendingInternalContinuation: (continuation) => set({ pendingInternalContinuation: continuation }),
  consumeInternalContinuation: (sessionId) => {
    const pending = get().pendingInternalContinuation
    if (!pending || pending.sessionId !== sessionId) return null
    set({ pendingInternalContinuation: null })
    return pending
  },
  markActiveRunUserAborted: (sessionId) => {
    const now = Date.now()
    set((state) => {
      const updateMessages = (messages: ChatMessage[]) => messages.map((message) => {
        if (!message.subAgents?.some((sub) => sub.status === 'running')) return message
        return {
          ...message,
          streaming: false,
          interrupted: true,
          subAgents: message.subAgents.map((sub) => sub.status === 'running'
            ? {
                ...sub,
                status: 'interrupted' as const,
                interruptionReason: 'user_aborted' as const,
                completedAt: now
              }
            : sub)
        }
      })
      const sessions = state.sessions.map((session) => session.id === sessionId
        ? { ...session, messages: updateMessages(session.messages) }
        : session)
      const active = sessions.find((session) => session.id === state.activeSessionId)
      return {
        sessions,
        messages: active?.messages ?? state.messages,
        pendingInternalContinuation: state.pendingInternalContinuation?.sessionId === sessionId
          ? null
          : state.pendingInternalContinuation
      }
    })
    void get().persistSession(sessionId)
  },
  setTasks: (tasks) => set((s) => ({
    tasks,
    sessions: s.sessions.map((session) =>
      session.id === s.activeSessionId ? { ...session, tasks } : session
    )
  })),

  revertToMessage: async (msgId: string) => {
    const s = get()
    const activeSession = s.sessions.find(ses => ses.id === s.activeSessionId)
    if (!activeSession) return

    const msgIndex = activeSession.messages.findIndex(m => m.id === msgId)
    if (msgIndex === -1) return

    const targetMessage = activeSession.messages[msgIndex]
    
    // Gather txIds from this message and all subsequent messages in reverse chronological order
    const txIds: string[] = []
    for (let i = activeSession.messages.length - 1; i >= msgIndex; i--) {
      const m = activeSession.messages[i]
      if (m.txId) {
        txIds.push(m.txId)
      }
    }

    if (txIds.length > 0) {
      const win = window as any
      const ipc = win?.electron?.ipcRenderer
      if (ipc) {
        // Run IPC call asynchronously, but don't wait for it to block UI responsiveness
        ipc.invoke(IPC_CHANNELS.CHAT_REVERT_MESSAGES, activeSession.id, txIds).catch(console.error)
      }
    }

    // Slice messages to remove this message and everything after
    const newMessages = activeSession.messages.slice(0, msgIndex)
    
    set((state) => {
      const nextSessions = state.sessions.map(ses => 
        ses.id === state.activeSessionId ? { ...ses, messages: newMessages } : ses
      )
      return { 
        messages: newMessages, 
        sessions: nextSessions,
        pendingPrompt: {
          text: targetMessage.content || '',
          attachments: targetMessage.attachments?.map((attachment) => ({ ...attachment })) || []
        }
      }
    })
    
    await get().persistCurrentSession()
  },

  previewRevertMessage: async (msgId: string) => {
    const s = get()
    const activeSession = s.sessions.find(ses => ses.id === s.activeSessionId)
    if (!activeSession) return null

    const msgIndex = activeSession.messages.findIndex(m => m.id === msgId)
    if (msgIndex === -1) return null

    const txIds: string[] = []
    for (let i = activeSession.messages.length - 1; i >= msgIndex; i--) {
      const m = activeSession.messages[i]
      if (m.txId) {
        txIds.push(m.txId)
      }
    }

    if (txIds.length === 0) {
      return { toDelete: [], toRestore: [] }
    }

    const win = window as any
    const ipc = win?.electron?.ipcRenderer
    if (ipc) {
      try {
        const preview = await ipc.invoke(IPC_CHANNELS.CHAT_PREVIEW_REVERT_MESSAGES, activeSession.id, txIds)
        return preview
      } catch (err) {
        console.error('Failed to preview revert:', err)
        return null
      }
    }
    return null
  }
})
