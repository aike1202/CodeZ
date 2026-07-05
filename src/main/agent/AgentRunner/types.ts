import type { StreamCallbacks, ChatRequestConfig } from '../../services/ChatService'
import type { ToolDefinition } from '../../../shared/types/provider'
import type { AskUserRequest, AskUserAnswer } from '../../tools/builtin/AskUserQuestionTool'
import type { PermissionRequest } from '../../services/PermissionManager'
import type { Plan } from '../../../shared/types/plan'

export interface SubAgentStartMeta {
  type: string
  description: string
  prompt: string
  depth?: 'quick' | 'normal' | 'exhaustive'
  expectations?: { questions: string[]; outOfScope?: string[] }
  parentToolCallId: string
}

export interface SubAgentEndResult {
  status: 'completed' | 'failed'
  output?: string
  qualitySummary?: any
  toolCallCount: number
  filesExamined?: string[]
  conclusion?: string
}

export interface AgentRunnerCallbacks extends StreamCallbacks {
  onToolStart?: (toolCallId: string, name: string, args: string, thoughtSignature?: string) => void
  onToolEnd?: (toolCallId: string, result: string) => void
  onPermissionRequest?: (request: PermissionRequest) => Promise<boolean>
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
}

export interface AgentRunConfig extends ChatRequestConfig {
  workspaceRoot: string
  tools?: ToolDefinition[]
  sessionId?: string
  contextWindowTokens?: number
}
