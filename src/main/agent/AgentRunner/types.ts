import type { StreamCallbacks, ChatRequestConfig } from '../../services/ChatService'
import type { ToolDefinition } from '../../../shared/types/provider'
import type { AskUserRequest, AskUserAnswer } from '../../tools/builtin/AskUserQuestionTool'
import type { PermissionRequest } from '../../services/PermissionManager'
import type { Plan } from '../../../shared/types/plan'

export interface AgentRunnerCallbacks extends StreamCallbacks {
  onToolStart?: (toolCallId: string, name: string, args: string, thoughtSignature?: string) => void
  onToolEnd?: (toolCallId: string, result: string) => void
  onPermissionRequest?: (request: PermissionRequest) => Promise<boolean>
  onAskUserRequest?: (request: AskUserRequest) => Promise<AskUserAnswer[]>
  onPlanReview?: (plan: Plan) => Promise<{ approved: boolean; feedback?: string }>
}

export interface AgentRunConfig extends ChatRequestConfig {
  workspaceRoot: string
  tools?: ToolDefinition[]
  sessionId?: string
  contextWindowTokens?: number
}
