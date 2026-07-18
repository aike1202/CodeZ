import type { TodoItem } from '../../../../shared/types/todo'
import type { PermissionApprovalResponse, PermissionRequest } from '../../../../shared/types/permission'
import type { CompactionTrigger, ContextBudgetSnapshot } from '../../../../shared/types/context'
import type { ImageAttachment, PendingPromptDraft } from '../../../../shared/types/attachment'
import type { ChatRuntimeStatusChanged } from '../../shared/desktop/generated/contracts'
import type { QueuedPrompt } from '../../../../shared/types/queuedPrompt'

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

export interface CompactionTimelineItem {
  id: string
  type: 'compaction'
  trigger?: CompactionTrigger
  status: 'running' | 'success' | 'error'
  tokensBefore?: number
  tokensAfter?: number
  error?: string
  startedAt: number
  updatedAt: number
  completedAt?: number
  sequence: number
}

export type ExecutionTimelineItem =
  | ReasoningTimelineItem
  | ToolTimelineItem
  | TextTimelineItem
  | CompactionTimelineItem

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
  streamPhase?: 'starting' | 'running'
  responseWaitWarning?: boolean
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
  todos?: TodoItem[]
  queuedPrompts?: QueuedPrompt[]
}

export interface CompactionUiState {
  status: 'idle' | 'running' | 'completed' | 'failed'
  trigger?: CompactionTrigger
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
  expandedCapsule: 'todo' | 'plan' | null
  planListModalOpen: boolean
  activePlan: any | null
  planReview: { plan: any; status: string } | null
  activePlanStreamId: string | null
  pendingPrompt: PendingPromptDraft | null
  composerDrafts: Record<string, PendingPromptDraft | undefined>
  pendingInternalContinuation: PendingInternalContinuation | null
  todos: TodoItem[]
  contextBudgets: Record<string, ContextBudgetSnapshot | undefined>
  compactionStates: Record<string, CompactionUiState | undefined>
  runtimeStatuses: Record<string, ChatRuntimeStatusChanged | undefined>
  blockedRuntimeSessionIds: Record<string, true | undefined>

  applyRuntimeStatus: (next: ChatRuntimeStatusChanged) => void
  refreshRuntimeStatuses: (sessionIds: string[]) => Promise<void>
  clearRuntimeStatus: (sessionId: string) => void
  allowRuntimeStatus: (sessionId: string) => void
  loadSessions: () => Promise<void>
  createSession: (projectId: string) => string
  selectSession: (sessionId: string) => Promise<void>
  linkPlanToSession: (sessionId: string, planSlug: string | null) => Promise<void>
  addUserMessage: (content: string, attachments?: ImageAttachment[], sessionId?: string) => ChatMessage
  removeMessages: (messageIds: string[]) => void
  addSystemMessage: (content: string) => ChatMessage
  startStreamingReply: (sessionId?: string) => string
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
  setEditStatuses: (
    msgId: string,
    statuses: Record<string, 'accepted' | 'rejected'>
  ) => void
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
  revertToMessage: (msgId: string) => Promise<boolean>
  previewRevertMessage: (msgId: string) => Promise<{ toDelete: string[], toRestore: string[] } | null>

  appendAgentState: (msgId: string, state: AgentState) => void
  updateAgentState: (msgId: string, stateId: string, updates: Partial<AgentState>) => void
  appendReasoningTimelineChunk: (msgId: string, delta: string) => void
  completeReasoningTimeline: (msgId: string) => void
  updateCompactionTimeline: (msgId: string, state: CompactionUiState) => void
  startToolCall: (msgId: string, toolCall: Omit<ToolCallState, 'status' | 'startedAt' | 'sequence'>) => void
  finishToolCall: (msgId: string, toolCallId: string, result: string) => void

  setExpandedCapsule: (capsule: 'todo' | 'plan' | null) => void
  initPlanStateListener: () => () => void
  setPlanListModalOpen: (open: boolean) => void
  setActivePlan: (plan: any | null) => void
  setPlanReview: (review: { plan: any; status: string } | null) => void
  setActivePlanStreamId: (streamId: string | null) => void
  setContextBudget: (sessionId: string, snapshot: ContextBudgetSnapshot) => void
  setCompactionState: (sessionId: string, state: CompactionUiState) => void
  setPendingPrompt: (prompt: PendingPromptDraft | null) => void
  setComposerDraft: (sessionId: string, draft: PendingPromptDraft) => void
  setPendingInternalContinuation: (continuation: PendingInternalContinuation | null) => void
  consumeInternalContinuation: (sessionId: string) => PendingInternalContinuation | null
  markActiveRunUserAborted: (sessionId: string) => void
  setTodos: (todos: TodoItem[]) => void
  setSessionTodos: (sessionId: string, todos: TodoItem[]) => void
}
