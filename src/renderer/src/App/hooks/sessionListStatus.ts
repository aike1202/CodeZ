import type { SessionRuntimeStatusChanged } from '@shared/types/subagent'
import type { ChatMessage } from '../../stores/chatStore/types'

export type SessionListStatus = 'action-required' | 'running' | 'error' | 'idle'

interface SessionListStatusInput {
  messages: ChatMessage[]
  runtimeStatus?: SessionRuntimeStatusChanged
}

const PRESENTATIONS: Record<SessionListStatus, { label: string; className: string }> = {
  'action-required': { label: '需要确认', className: 'action-required' },
  running: { label: '正在运行', className: 'running' },
  error: { label: '执行出错', className: 'error' },
  idle: { label: '空闲', className: 'idle' }
}

export function deriveSessionListStatus({
  messages,
  runtimeStatus
}: SessionListStatusInput): SessionListStatus {
  const actionRequired = messages.some((message) =>
    message.permissionRequests?.some((request) => request.status === 'pending') ||
    message.askUserRequests?.some((request) => request.status === 'pending'))
  if (actionRequired) return 'action-required'

  const runtime = runtimeStatus?.status
  if (runtime?.mainRunnerActive || runtime?.activeSubAgentIds.length) return 'running'

  const latestExecution = [...messages].reverse().find((message) => message.executionStatus)
  return latestExecution?.executionStatus === 'error' ? 'error' : 'idle'
}

export function getSessionStatusPresentation(status: SessionListStatus) {
  return PRESENTATIONS[status]
}
