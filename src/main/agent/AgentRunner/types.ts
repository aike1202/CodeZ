import type { StreamCallbacks, ChatRequestConfig } from '../../services/ChatService'
import type { ModelContextCapabilities, ToolDefinition } from '../../../shared/types/provider'
import type { AskUserRequest, AskUserAnswer } from '../../tools/builtin/AskUserQuestionTool'
import type { PermissionRequest } from '../../services/PermissionManager'
import type { PermissionApprovalResponse } from '../../../shared/types/permission'
import type { Plan } from '../../../shared/types/plan'
import type { ContextBudgetSnapshot } from '../../../shared/types/context'
import type { RuntimeTurnHandle, SessionRuntimeCoordinator } from '../../services/context/SessionRuntimeCoordinator'
import type { ModelContextBuilder } from '../../services/context/ModelContextBuilder'
import type { CompactionService } from '../../services/context/CompactionService'
import type { ToolBatchMeta } from '../../../shared/types/toolExecution'
import type { ImageAttachment, ResolveImageAttachment } from '../../../shared/types/attachment'

export interface SubAgentStartMeta {
  type: string
  description: string
  prompt: string
  depth?: 'quick' | 'normal' | 'exhaustive'
  expectations?: { questions: string[]; outOfScope?: string[] }
  parentToolCallId: string
}

export interface SubAgentEndResult {
  status: 'completed' | 'failed' | 'interrupted'
  output?: string
  qualitySummary?: any
  toolCallCount: number
  filesExamined?: string[]
  conclusion?: string
}

export interface AgentRunnerCallbacks extends StreamCallbacks {
  onToolStart?: (
    toolCallId: string,
    name: string,
    args: string,
    thoughtSignature?: string,
    batch?: ToolBatchMeta
  ) => void
  onToolEnd?: (toolCallId: string, result: string) => void
  onPermissionRequest?: (request: PermissionRequest) => Promise<boolean | PermissionApprovalResponse>
  onAskUserRequest?: (request: AskUserRequest) => Promise<AskUserAnswer[]>
  onPlanReview?: (plan: Plan) => Promise<{ approved: boolean; feedback?: string }>

  // SubAgent 作用域事件 — 与主 Agent 时间线分离，由 SubAgentCard 消费
  onSubAgentStart?: (subAgentId: string, meta: SubAgentStartMeta) => void
  onSubAgentEnd?: (subAgentId: string, result: SubAgentEndResult) => void
  onSubAgentChunk?: (subAgentId: string, delta: string, reasoningDelta: string) => void
  onSubAgentToolStart?: (
    subAgentId: string,
    toolCallId: string,
    name: string,
    args: string,
    thoughtSignature?: string
  ) => void
  onSubAgentToolEnd?: (subAgentId: string, toolCallId: string, result: string) => void
  onContextBudget?: (snapshot: ContextBudgetSnapshot) => void
}

export interface AgentRunConfig extends Omit<ChatRequestConfig, 'messages'> {
  workspaceRoot: string
  tools?: ToolDefinition[]
  sessionId?: string
  providerId?: string
  runtimeTurn?: RuntimeTurnHandle
  runtimeCoordinator?: SessionRuntimeCoordinator
  contextBuilder?: ModelContextBuilder
  compactionService?: CompactionService
  contextCapabilities?: ModelContextCapabilities
  systemPrompt?: string
  contextInstructions?: string[]
  prepareImages?: (attachments: ImageAttachment[]) => Promise<ResolveImageAttachment>
}
