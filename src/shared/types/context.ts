import type { AgentStopReason, ProviderTokenUsage } from './provider'

export const MAIN_CONTEXT_SCOPE = 'main' as const
export const CONTEXT_SCHEMA_VERSION = 1 as const

export type ContextScopeId = typeof MAIN_CONTEXT_SCOPE | `subagent:${string}`
export type LedgerEventType =
  | 'user_message'
  | 'assistant_message'
  | 'tool_result'
  | 'turn_completed'
  | 'turn_interrupted'
  | 'resume_state_updated'
  | 'compaction_started'
  | 'compaction_completed'
  | 'compaction_failed'
  | 'legacy_import_completed'

const HISTORY_EVENT_TYPES = new Set<LedgerEventType>([
  'user_message', 'assistant_message', 'tool_result', 'turn_interrupted',
  'resume_state_updated', 'compaction_completed', 'legacy_import_completed'
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

export interface NormalizedModelMessage {
  id: string
  turnId: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: NormalizedToolCall[]
  toolCallId?: string
  name?: string
  status: 'complete' | 'interrupted'
  createdAt: string
  sourceSequence?: number
}

export interface ModelContextItem {
  kind: 'system' | 'compaction_summary' | 'resume_state' | 'user' | 'assistant' | 'tool'
  message: NormalizedModelMessage | { role: 'system'; content: string }
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
}

export interface ToolResultPayload {
  message: NormalizedModelMessage
  status: 'success' | 'error' | 'interrupted'
  fullResultSha256?: string
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

export interface CompactionCompletedPayload {
  trigger: CompactionTrigger
  sourceHistoryVersion: number
  coveredThroughSequence: number
  retainedFromSequence?: number
  tokensBefore: number
  tokensAfter: number
  sourceHash: string
  summary: CompactionSummaryV1
  resumeState?: VersionedResumeState
  activeMessages: NormalizedModelMessage[]
}

export interface CompactionFailedPayload {
  trigger: CompactionTrigger
  stage: string
  code: ContextErrorCode
  message: string
  retryable: boolean
}

export interface LegacyImportCompletedPayload {
  sourceHash: string
  mode: 'summary' | 'recent-text-fallback'
  activeMessages: NormalizedModelMessage[]
  summary?: CompactionSummaryV1
}

export interface LedgerPayloadByType {
  user_message: UserMessagePayload
  assistant_message: AssistantMessagePayload
  tool_result: ToolResultPayload
  turn_completed: TurnCompletedPayload
  turn_interrupted: TurnInterruptedPayload
  resume_state_updated: { resumeState: VersionedResumeState }
  compaction_started: CompactionStartedPayload
  compaction_completed: CompactionCompletedPayload
  compaction_failed: CompactionFailedPayload
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
  latestCompaction?: CompactionSummaryV1
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
    isSystem?: boolean
    commandMetadata?: unknown
  }
}
