import type { AgentStopReason, ProviderTokenUsage } from './provider'
import type { ImageAttachment } from './attachment'

export const MAIN_CONTEXT_SCOPE = 'main' as const
export const CONTEXT_SCHEMA_VERSION = 1 as const

export type ContextScopeId = typeof MAIN_CONTEXT_SCOPE | `subagent:${string}`
export type LedgerEventType =
  | 'user_message'
  | 'assistant_message'
  | 'tool_result'
  | 'skill_state_updated'
  | 'turn_completed'
  | 'turn_interrupted'
  | 'resume_state_updated'
  | 'compaction_started'
  | 'compaction_completed'
  | 'compaction_failed'
  | 'history_reverted'
  | 'legacy_import_completed'

const HISTORY_EVENT_TYPES = new Set<LedgerEventType>([
  'user_message', 'assistant_message', 'tool_result', 'turn_interrupted',
  'skill_state_updated', 'resume_state_updated', 'compaction_completed', 'legacy_import_completed',
  'history_reverted'
])

export function contextScopeForSubAgent(runId: string): ContextScopeId {
  if (!runId.trim()) throw new Error('runId is required')
  return `subagent:${runId}`
}

export function eventChangesHistory(type: LedgerEventType): boolean {
  return HISTORY_EVENT_TYPES.has(type)
}

export interface GoalSnapshot {
  id?: string
  title?: string
  originalPrompt: string
  normalizedGoal?: string
  keyRequirements: string[]
  nonGoals?: string[]
  successCriteria?: string[]
  updatedAt?: string
}

export interface TaskPlan {
  currentStep: string
  completedSteps: string[]
  pendingSteps: string[]
}

export interface ResumeState {
  currentGoalId: string
  currentPhase: string
  currentStep: string
  lastCompletedStep?: string
  nextAction: string
  openQuestions: string[]
  blockedBy: string[]
  filesTouched: string[]
  filesToInspectNext: string[]
  validationPending: string[]
  validationResults?: Array<{
    commandOrCheck: string
    status: 'passed' | 'failed'
    result?: string
  }>
  goal?: GoalSnapshot
  plan?: TaskPlan
  contextFiles?: string[]
  lastTrimmedAt?: number
  updatedAt?: string
}

export interface VersionedResumeState {
  revision: number
  coveredThroughSequence: number
  source: 'explicit_tool' | 'compaction' | 'framework'
  updatedAt: string
  state: ResumeState
}

export interface NormalizedToolCall {
  id: string
  name: string
  arguments: string
  thoughtSignature?: string
}

export interface FileContextReference {
  path: string
  sha256: string
  operation: 'read' | 'edit' | 'write'
  /** True only when this message contains the file contents visible to the model. */
  contentIncluded: boolean
  /** Hash of the exact rendered content, used to deduplicate identical Read ranges. */
  contentSha256?: string
  offset?: number
  limit?: number
  /** 1-indexed character offset within a single requested line. */
  characterOffset?: number
  /** Durable ledger ordering used to restore the most recently accessed files. */
  accessSequence?: number
  /** Exact block boundaries inside a Read tool result, enabling per-file projection. */
  resultBlockStart?: number
  resultBlockEnd?: number
}

export interface PostCompactionFileBlock {
  reference: FileContextReference
  /** Numbered file text. It is JSON-escaped before entering a provider request. */
  content: string
  /** Filesystem version used to invalidate restored text after external changes. */
  statSignature: string
  realPath?: string
}

export interface PostCompactionFileContext {
  /** Safe JSON data projection; legacy snapshots may contain the old XML rendering here. */
  content: string
  fileReferences: FileContextReference[]
  blocks?: PostCompactionFileBlock[]
  createdAt: string
  sourceSequence?: number
}

export interface InvokedSkillContextEntry {
  name: string
  content: string
  invokedSequence: number
}

export type SessionSkillStatus = 'active' | 'inactive' | 'disabled'

export interface SessionSkillState {
  name: string
  status: SessionSkillStatus
  content?: string
  contentHash?: string
  args?: string
  source: 'model' | 'user' | 'recovery'
  reason?: string
  updatedAt: string
  updatedSequence: number
}

export interface PostCompactionSkillContext {
  content: string
  skills: InvokedSkillContextEntry[]
  createdAt: string
  sourceSequence?: number
}

export interface NormalizedModelMessage {
  id: string
  /** Renderer message identity used for durable conversation history operations. */
  clientMessageId?: string
  turnId: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: NormalizedToolCall[]
  toolCallId?: string
  name?: string
  status: 'complete' | 'interrupted'
  createdAt: string
  sourceSequence?: number
  attachments?: ImageAttachment[]
  /** Client-side file working-set metadata. Provider adapters do not serialize it. */
  fileReferences?: FileContextReference[]
}

export interface ModelContextItem {
  kind: 'system' | 'compaction_summary' | 'resume_state' | 'skill_context' | 'skill_state' | 'file_context' | 'user' | 'assistant' | 'tool'
  message: NormalizedModelMessage | {
    role: 'system'
    content: string
    fileReferences?: FileContextReference[]
    sourceSequence?: number
  }
}

export interface CompactionSummaryV1 {
  version: 1
  goal: {
    originalRequest?: string
    currentObjective: string
    requirements: string[]
    successCriteria: string[]
  }
  status: {
    phase: string
    completed: string[]
    inProgress: string[]
    nextActions: string[]
  }
  decisions: Array<{ decision: string; rationale?: string }>
  facts: Array<{ fact: string; evidence?: string }>
  files: Array<{
    path: string
    relevance: string
    state: 'read' | 'modified' | 'created' | 'deleted' | 'unknown'
  }>
  validation: Array<{
    commandOrCheck: string
    result: string
    status: 'passed' | 'failed' | 'pending'
  }>
  errors: Array<{ symptom: string; cause?: string; resolution?: string }>
  openQuestions: string[]
  userInstructions: string[]
  coveredThroughSequence: number
}

export interface CompactionSummaryV2 {
  version: 2
  format: 'text'
  content: string
  coveredThroughSequence: number
  /** Oldest source content omitted only as a last-resort Provider overflow recovery. */
  truncatedPrefixThroughSequence?: number
}

export type CompactionSummary = CompactionSummaryV1 | CompactionSummaryV2

export type ContextPressureLevel = 'normal' | 'warning' | 'prune' | 'compact' | 'overflow'
export type ContextEstimateSource = 'provider' | 'tokenizer' | 'heuristic'

export interface ContextBudgetSnapshot {
  hardInputLimit: number
  usableInputBudget: number
  systemPromptTokens: number
  toolSchemaTokens: number
  instructionTokens: number
  protocolTokens: number
  summaryTokens: number
  recentHistoryTokens: number
  rawHistoryTokens: number
  currentInputTokens: number
  outputReserveTokens: number
  safetyMarginTokens: number
  totalInputTokens: number
  providerAdjustmentTokens: number
  pressureLevel: ContextPressureLevel
  estimateSource: ContextEstimateSource
  historyVersion: number
}

export type CompactionTrigger =
  | 'auto_threshold'
  | 'provider_overflow'
  | 'manual'
  | 'model_downshift'
  | 'migration'

export type ContextErrorCode =
  | 'LEDGER_WRITE_FAILED'
  | 'LEDGER_CORRUPTED'
  | 'SNAPSHOT_COMMIT_FAILED'
  | 'BUDGET_UNAVAILABLE'
  | 'CURRENT_INPUT_TOO_LARGE'
  | 'COMPACTION_SUMMARY_FAILED'
  | 'COMPACTION_SCHEMA_INVALID'
  | 'COMPACTION_STALE_VERSION'
  | 'COMPACTION_INSUFFICIENT_REDUCTION'
  | 'PROVIDER_CONTEXT_OVERFLOW'
  | 'LEGACY_MIGRATION_FAILED'

export interface UserMessagePayload {
  message: NormalizedModelMessage
  providerId?: string
  model?: string
  commandMetadata?: unknown
}

export interface AssistantMessagePayload {
  message: NormalizedModelMessage
  usage?: ProviderTokenUsage
  /** Fingerprint of the exact Provider request measured by usage. */
  requestFingerprint?: string
}

export interface ToolResultPayload {
  message: NormalizedModelMessage
  status: 'success' | 'error' | 'interrupted'
  fullResultSha256?: string
}

export interface SkillStateUpdatedPayload {
  name: string
  status: SessionSkillStatus
  content?: string
  contentHash?: string
  args?: string
  source: SessionSkillState['source']
  reason?: string
}

export interface TurnCompletedPayload {
  stopReason: AgentStopReason
  usage?: ProviderTokenUsage
  completedAt: string
}

export interface TurnInterruptedPayload {
  reason: string
  interruptedMessages: NormalizedModelMessage[]
}

export interface CompactionStartedPayload {
  trigger: CompactionTrigger
  sourceHistoryVersion: number
  candidateThroughSequence: number
  tokensBefore: number
}

export interface ObservedProviderInputLimit {
  providerId?: string
  model?: string
  maxInputTokens: number
}

export interface CompactionCompletedPayload {
  trigger: CompactionTrigger
  sourceHistoryVersion: number
  coveredThroughSequence: number
  retainedFromSequence?: number
  tokensBefore: number
  tokensAfter: number
  sourceHash: string
  summary: CompactionSummary
  observedProviderInputLimit?: ObservedProviderInputLimit
  resumeState?: VersionedResumeState
  activeMessages: NormalizedModelMessage[]
  postCompactionFileContext?: PostCompactionFileContext
  postCompactionSkillContext?: PostCompactionSkillContext
  skillStates?: SessionSkillState[]
  postCompactionSkillStates?: SessionSkillState[]
}

export interface CompactionFailedPayload {
  trigger: CompactionTrigger
  stage: string
  code: ContextErrorCode
  message: string
  retryable: boolean
}

export interface HistoryRevertedPayload {
  sourceHistoryVersion: number
  targetUiMessageId: string
  targetMessageId: string
  activeMessages: NormalizedModelMessage[]
  skillStates?: SessionSkillState[]
}

export interface LegacyImportCompletedPayload {
  sourceHash: string
  mode: 'summary' | 'recent-text-fallback'
  activeMessages: NormalizedModelMessage[]
  summary?: CompactionSummary
}

export interface LedgerPayloadByType {
  user_message: UserMessagePayload
  assistant_message: AssistantMessagePayload
  tool_result: ToolResultPayload
  skill_state_updated: SkillStateUpdatedPayload
  turn_completed: TurnCompletedPayload
  turn_interrupted: TurnInterruptedPayload
  resume_state_updated: { resumeState: VersionedResumeState }
  compaction_started: CompactionStartedPayload
  compaction_completed: CompactionCompletedPayload
  compaction_failed: CompactionFailedPayload
  history_reverted: HistoryRevertedPayload
  legacy_import_completed: LegacyImportCompletedPayload
}

export interface LedgerEvent<
  TType extends LedgerEventType = LedgerEventType,
  TPayload = LedgerPayloadByType[TType]
> {
  schemaVersion: 1
  eventId: string
  sessionId: string
  contextScopeId: ContextScopeId
  sequence: number
  historyVersion: number
  turnId?: string
  createdAt: string
  type: TType
  payload: TPayload
}

export type AnyLedgerEvent = {
  [TType in LedgerEventType]: LedgerEvent<TType, LedgerPayloadByType[TType]>
}[LedgerEventType]

export interface SessionRuntimeScopeSnapshot {
  historyVersion: number
  activeMessages: NormalizedModelMessage[]
  latestCompaction?: CompactionSummary
  observedProviderInputLimit?: ObservedProviderInputLimit
  resumeState?: VersionedResumeState
  lastCompletedTurnId?: string
  lastInterruptedTurnId?: string
  legacyImport?: {
    sourceHash: string
    mode: 'summary' | 'recent-text-fallback'
    eventId: string
  }
  latestCompactionResumeRevision?: number
  lastProviderId?: string
  lastModel?: string
  lastProviderUsage?: ProviderTokenUsage
  lastProviderUsageMessageId?: string
  lastProviderUsageProviderId?: string
  lastProviderUsageModel?: string
  lastProviderUsageRequestFingerprint?: string
  postCompactionFileContext?: PostCompactionFileContext
  postCompactionSkillContext?: PostCompactionSkillContext
  skillStates?: SessionSkillState[]
  postCompactionSkillStates?: SessionSkillState[]
}

export interface SessionRuntimeSnapshot {
  schemaVersion: 1
  sessionId: string
  throughSequence: number
  createdAt: string
  scopes: Record<string, SessionRuntimeScopeSnapshot>
}

export interface SessionRuntimeRef {
  schemaVersion: 2
  ledgerVersion: 1
  migratedAt?: string
  legacySourceHash?: string
  legacyImportMode?: 'summary' | 'recent-text-fallback'
}

export interface StreamRequestV2 {
  streamId: string
  providerId: string
  model: string
  sessionId: string
  input: {
    text: string
    attachments?: ImageAttachment[]
    isSystem?: boolean
    commandMetadata?: unknown
  }
}
