import type { TaskItem } from '../../../../shared/types/task'
import type { PermissionApprovalResponse, PermissionRequest } from '../../../../shared/types/permission'
import type { ContextBudgetSnapshot } from '../../../../shared/types/context'
import type { ImageAttachment, PendingPromptDraft } from '../../../../shared/types/attachment'
import type { SessionRuntimeStatusChanged } from '../../../../shared/types/subagent'

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
  batchId?: string
  batchIndex?: number
  batchSize?: number
  textAskUserFallback?: boolean
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

/** 子 Agent 调用记录 — 与主 Agent 时间线分离，由 SubAgentCard 消费 */
export interface SubAgentRecord {
  id: string
  type: string
  description: string
  prompt: string
  depth?: 'quick' | 'normal' | 'exhaustive'
  expectations?: { questions: string[]; outOfScope?: string[] }
  context?: string
  scope?: { directories?: string[]; excludeGlobs?: string[] }
  parentToolCallId: string
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  interruptionReason?: 'runtime_missing' | 'user_aborted'
  startedAt: number
  completedAt?: number
  content: string
  reasoningContent?: string
  toolCalls: ToolCallState[]
  executionTimeline: ExecutionTimelineItem[]
  result?: {
    output?: string
    qualitySummary?: any
    toolCallCount: number
    filesExamined?: string[]
    conclusion?: string
  }
}

export interface PermissionRequestState extends PermissionRequest {
  status: 'pending' | 'approved' | 'denied' | 'interrupted'
  createdAt: number
}

export interface AskUserOptionState {
  label: string
  description?: string
  /** 选项的详细说明（markdown），前端按内容动态展示 */
  detail?: string
}

export interface AskUserQuestionItemState {
  question: string
  header: string
  options: AskUserOptionState[]
  multiSelect?: boolean
  /** 自定义"忽略"按钮文案，默认"忽略" */
  ignoreLabel?: string
  /** 自定义"提交"按钮文案，默认"提交" */
  submitLabel?: string
}

export interface AskUserRequestState {
  id: string
  questions: AskUserQuestionItemState[]
  status: 'pending' | 'answered' | 'interrupted'
  answers?: Array<{ question: string; answer: string | string[] }>
  createdAt: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'agent' | 'system'
  content: string
  streaming?: boolean
  interrupted?: boolean
  executionStatus?: 'completed' | 'error' | 'interrupted'
  reasoningContent?: string
  agentStates?: AgentState[]
  toolCalls?: ToolCallState[]
  executionTimeline?: ExecutionTimelineItem[]
  txId?: string
  editStatuses?: Record<string, 'accepted' | 'rejected'>
  diffEntries?: Array<{ path: string; diff: string }>
  permissionRequests?: PermissionRequestState[]
  askUserRequests?: AskUserRequestState[]
  subAgents?: SubAgentRecord[]
  attachments?: ImageAttachment[]
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
  linkedPlanSlug?: string
  tasks?: TaskItem[]
}

export interface CompactionUiState {
  status: 'idle' | 'running' | 'completed' | 'failed'
  trigger?: string
  tokensBefore?: number
  tokensAfter?: number
  error?: string
}

export interface PendingInternalContinuation {
  sessionId: string
  text: string
}

export interface ChatState {
  sessions: ChatSession[]
  activeSessionId: string | null
  messages: ChatMessage[]
  streamCleanups: Record<string, (() => void) | null>
  expandedCapsule: 'task' | 'plan' | null
  subAgentStatus: 'idle' | 'running' | 'completed' | 'failed'
  planListModalOpen: boolean
  activePlan: any | null
  planReview: { plan: any; status: string } | null
  activePlanStreamId: string | null
  pendingPrompt: PendingPromptDraft | null
  pendingInternalContinuation: PendingInternalContinuation | null
  tasks: TaskItem[]
  contextBudgets: Record<string, ContextBudgetSnapshot | undefined>
  compactionStates: Record<string, CompactionUiState | undefined>
  runtimeStatuses: Record<string, SessionRuntimeStatusChanged | undefined>
  blockedRuntimeSessionIds: Record<string, true | undefined>

  applyRuntimeStatus: (next: SessionRuntimeStatusChanged) => void
  refreshRuntimeStatuses: (sessionIds: string[]) => Promise<void>
  clearRuntimeStatus: (sessionId: string) => void
  allowRuntimeStatus: (sessionId: string) => void
  loadSessions: () => Promise<void>
  createSession: (projectId: string) => string
  selectSession: (sessionId: string) => Promise<void>
  linkPlanToSession: (sessionId: string, planSlug: string | null) => Promise<void>
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
  setStreamCleanup: (sessionId: string, cleanup: (() => void) | null) => void
  setTransactionId: (msgId: string, txId: string) => void
  setDiffEntries: (msgId: string, diffEntries: Array<{ path: string; diff: string }>) => void
  setEditStatus: (msgId: string, filePath: string, status: 'accepted' | 'rejected') => void
  addPermissionRequest: (msgId: string, request: Omit<PermissionRequestState, 'status' | 'createdAt'>) => void
  resolvePermissionRequest: (msgId: string, requestId: string, response: PermissionApprovalResponse) => void
  addAskUserRequest: (msgId: string, request: Omit<AskUserRequestState, 'status' | 'createdAt'>) => void
  resolveAskUserRequest: (
    msgId: string,
    requestId: string,
    answers: Array<{ question: string; answer: string | string[] }>
  ) => void
  persistCurrentSession: () => Promise<void>
  persistSession: (sessionId: string) => Promise<void>
  archiveSession: (sessionId: string, archive: boolean) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  restoreSession: (sessionId: string) => Promise<void>
  revertToMessage: (msgId: string) => Promise<void>
  previewRevertMessage: (msgId: string) => Promise<{ toDelete: string[], toRestore: string[] } | null>

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
    result: { status: 'completed' | 'failed' | 'interrupted'; output?: string; qualitySummary?: any; toolCallCount: number; filesExamined?: string[] }
  ) => void

  setExpandedCapsule: (capsule: 'task' | 'plan' | null) => void
  setSubAgentStatus: (status: 'idle' | 'running' | 'completed' | 'failed') => void
  initPlanStateListener: () => () => void
  setPlanListModalOpen: (open: boolean) => void
  setActivePlan: (plan: any | null) => void
  setPlanReview: (review: { plan: any; status: string } | null) => void
  setActivePlanStreamId: (streamId: string | null) => void
  setContextBudget: (sessionId: string, snapshot: ContextBudgetSnapshot) => void
  setCompactionState: (sessionId: string, state: CompactionUiState) => void
  setPendingPrompt: (prompt: PendingPromptDraft | null) => void
  setPendingInternalContinuation: (continuation: PendingInternalContinuation | null) => void
  consumeInternalContinuation: (sessionId: string) => PendingInternalContinuation | null
  markActiveRunUserAborted: (sessionId: string) => void
  setTasks: (tasks: TaskItem[]) => void
}
