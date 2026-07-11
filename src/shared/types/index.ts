export type {
  WorkspaceInfo,
  FileTreeNode,
  FileContent,
  ProjectInfo,
} from './workspace'

export type {
  ProviderConfig,
  ProviderInfo,
  ProviderFormData,
  ModelInfo,
  ConnectionTestResult,
  ChatMessage,
  ChatStreamChunk,
  ChatStreamEnd,
} from './provider'

export type {
  ProjectSnapshot,
  ProjectSnapshotOptions,
  ReadManyFilesOptions,
  ReadManyFilesResult,
  SearchCodeOptions,
  CodeSearchResult,
  SymbolMapOptions,
  SymbolMapResult,
} from './project-analysis'

export interface AgentTask {
  id: string
  title: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  createdAt: string
}

export type {
  SessionData
} from './session'

export type {
  SkillDefinition
} from './skill'

export type {
  PermissionMode,
  PermissionRiskLevel,
  PermissionAction,
  PermissionApprovalScope,
  PermissionCapability,
  PermissionAnalysisStatus,
  PermissionImpact,
  PermissionSnapshot,
  PermissionCheck,
  PermissionDecision,
  PermissionRequest,
  PermissionApprovalResponse
} from './permission'

export { DEFAULT_PERMISSION_MODE, allowedScopesForDecision, allowedScopesForRisk } from './permission'

export type {
  ContextScopeId,
  LedgerEventType,
  GoalSnapshot,
  TaskPlan,
  ResumeState,
  VersionedResumeState,
  NormalizedToolCall,
  NormalizedModelMessage,
  ModelContextItem,
  CompactionSummaryV1,
  ContextBudgetSnapshot,
  CompactionTrigger,
  ContextErrorCode,
  LedgerPayloadByType,
  LedgerEvent,
  AnyLedgerEvent,
  SessionRuntimeScopeSnapshot,
  SessionRuntimeSnapshot,
  SessionRuntimeRef,
  StreamRequestV2
} from './context'

export type { ToolBatchMeta } from './toolExecution'

export type {
  ImageMimeType,
  ImageAttachmentBase,
  ImageAttachment,
  DraftImageAttachment,
  ComposerImageAttachment,
  AttachmentPreviewBytes,
  ResolvedImageAttachment,
  ResolveImageAttachment,
  ProviderImagePolicy,
  PendingPromptDraft
} from './attachment'

export { MAIN_CONTEXT_SCOPE, CONTEXT_SCHEMA_VERSION, contextScopeForSubAgent, eventChangesHistory } from './context'
