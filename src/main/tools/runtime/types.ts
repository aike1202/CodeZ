import type { FileContextReference } from '../../../shared/types/context'
import type { ToolApprovalPreference } from '../../../shared/types/permission'
import type { Tool, ToolContext, ToolExecutionOutput } from '../Tool'

export type JsonSchemaObject = Record<string, unknown> & { type?: string }
export type ToolSource = 'builtin' | 'skill' | 'mcp' | 'plugin'
export type ToolExposure = 'always' | 'core' | 'deferred' | 'internal'
export type ToolConcurrency = 'safe' | 'resource-locked' | 'exclusive'
export type ToolInterruptBehavior = 'cancel' | 'block' | 'detach'
export type AgentRole = 'main' | 'explore' | 'execution-planner' | 'executor' | string

export interface ToolApprovalMetadata {
  modelPreference: 'not-applicable' | 'required'
}

export interface ToolAvailabilityContext {
  platform: NodeJS.Platform
  agentRole: AgentRole
  workspaceRoot?: string
}

export type ToolEffect =
  | { kind: 'read-file'; path: string; scope: 'workspace' | 'external' }
  | { kind: 'write-file'; path: string; mode: 'create' | 'modify' | 'overwrite' }
  | { kind: 'delete-file'; path: string }
  | { kind: 'execute-command'; shell: 'bash' | 'powershell'; command: string }
  | { kind: 'network'; target?: string; method?: string }
  | { kind: 'external-effect'; target: string }
  | { kind: 'notify-user'; channel: 'desktop' | 'remote' }
  | { kind: 'spawn-agent'; role: string; isolation?: string }
  | { kind: 'control-execution'; executionId: string; action: string }
  | { kind: 'mutate-task-state'; sessionId?: string }
  | { kind: 'read-memory'; path: string }
  | { kind: 'internal'; target: string }
  | { kind: 'user-interaction'; channel: 'ask-user' }
  | { kind: 'rollback'; target: string }
  | { kind: 'unknown'; target: string }

export interface ToolEffectPlan {
  effects: readonly ToolEffect[]
  analysisStatus: 'parsed' | 'partial' | 'unparsed'
}

export interface ToolPlanningContext {
  workspaceRoot: string
  sessionId?: string
  agentRole: AgentRole
}

export interface ToolDescriptor {
  name: string
  aliases: readonly string[]
  version: string
  source: ToolSource
  sourceId: string
  summary: string
  description: string
  searchHint?: string
  inputSchema: JsonSchemaObject
  outputSchema?: JsonSchemaObject
  approval: ToolApprovalMetadata
  availability: {
    enabled(context: ToolAvailabilityContext): boolean
    roles: readonly AgentRole[] | '*'
    platforms?: readonly NodeJS.Platform[]
    exposure: ToolExposure
  }
  behavior: {
    readOnly(input: unknown): boolean
    destructive(input: unknown): boolean
    concurrency: ToolConcurrency
    interrupt: ToolInterruptBehavior
    maxResultChars: number
    timeoutMs?: number
  }
  planEffects(input: unknown, context: ToolPlanningContext): Promise<ToolEffectPlan>
  resourceKeys(input: unknown, context: ToolPlanningContext): Promise<readonly string[]>
}

export interface ToolExecutionError {
  code: string
  message: string
  recoverable: boolean
  suggestion?: string
  retryAfterMs?: number
  details?: Record<string, unknown>
}

export type ToolExecutionResult<T = unknown> =
  | {
      status: 'success'
      data?: T
      modelContent: string
      uiContent?: string
      fileReferences?: FileContextReference[]
      effects?: readonly ToolEffect[]
    }
  | {
      status: 'error' | 'denied' | 'cancelled'
      error: ToolExecutionError
      modelContent?: string
      uiContent?: string
      effects?: readonly ToolEffect[]
    }

export interface ToolHandler<TInput = unknown, TOutput = unknown> {
  readonly descriptor: ToolDescriptor
  readonly legacyTool?: Tool
  execute(input: TInput, context: ToolContext): Promise<ToolExecutionResult<TOutput>>
}

export interface ToolCatalogSnapshot {
  id: string
  createdAt: string
  descriptors: readonly ToolDescriptor[]
  handlersByCanonicalName: ReadonlyMap<string, ToolHandler>
  aliases: ReadonlyMap<string, string>
  fingerprint: string
}

export interface DeferredToolSummary {
  name: string
  summary: string
  searchHint?: string
}

export interface ToolExposurePlan {
  id: string
  catalogSnapshotId: string
  eagerTools: readonly ToolDescriptor[]
  deferredTools: readonly DeferredToolSummary[]
  hiddenTools: readonly { name: string; reason: string }[]
  schemaFingerprint: string
  estimatedSchemaTokens: number
}

export interface ToolExposureRequest {
  catalog: ToolCatalogSnapshot
  agentRole: AgentRole
  deniedTools?: ReadonlySet<string>
  activatedDeferredTools?: ReadonlySet<string>
  maxTools?: number
  schemaTokenBudget?: number
}

export interface NormalizedToolCall {
  callId: string
  position: number
  name: string
  rawArguments: string
  thoughtSignature?: string
  providerMetadata?: Record<string, unknown>
}

export interface ToolCallFragment {
  provider: 'openai' | 'anthropic' | 'gemini'
  position: number
  callId?: string
  nameDelta?: string
  argumentsDelta?: string
  completeArguments?: unknown
  thoughtSignature?: string
  isFinal?: boolean
}

export interface PreparedToolCall {
  call: NormalizedToolCall
  handler: ToolHandler
  input: Record<string, unknown>
  approvalPreference: ToolApprovalPreference | null
  effects: ToolEffectPlan
  resourceKeys: readonly string[]
}

export interface ToolPipelineResult {
  call: NormalizedToolCall
  canonicalName: string
  input?: Record<string, unknown>
  maxResultChars?: number
  result: ToolExecutionResult
}

export interface ToolAuthorizationDecision {
  allowed: boolean
  requestId: string
  error?: ToolExecutionError
  permissionRuleId?: string
  permissionMode?: string
}

export interface ToolBeforeExecuteHookContext {
  prepared: PreparedToolCall
  toolContext: ToolContext
}

export type ToolBeforeExecuteHookResult =
  | { action: 'continue' }
  | { action: 'deny'; error: ToolExecutionError }
  | { action: 'replace-input'; input: Record<string, unknown>; reason: string }

export interface ToolAfterExecuteHookContext extends ToolBeforeExecuteHookContext {
  result: ToolExecutionResult
}

export interface ToolRuntimeHook {
  name: string
  beforeExecute?(context: ToolBeforeExecuteHookContext): Promise<ToolBeforeExecuteHookResult>
  afterExecute?(context: ToolAfterExecuteHookContext): Promise<ToolExecutionResult | void>
}

export interface ToolExecutionWave {
  index: number
  calls: readonly PreparedToolCall[]
  reason: 'independent' | 'resource-serialized' | 'exclusive'
}

export function toLegacyExecutionOutput(result: ToolExecutionResult): ToolExecutionOutput {
  if (result.status === 'success') {
    return {
      content: result.modelContent,
      uiContent: result.uiContent,
      fileReferences: result.fileReferences
    }
  }
  return {
    content: `Error: ${result.error.message}`,
    uiContent: result.uiContent
  }
}
