import type { AgentState, ExecutionTimelineItem, ToolCallState } from '../../../stores/chatStore'

export interface ExecutionLogProps {
  timeline?: ExecutionTimelineItem[]
  reasoning?: string
  agentStates?: AgentState[]
  toolCalls?: ToolCallState[]
  onFileClick?: (filePath: string, virtualContent?: string) => void
  onDiffClick?: (
    filePath: string,
    editInfo: {
      type: 'write' | 'replace'
      targetContent?: string
      replacementContent?: string
      codeContent?: string
    }
  ) => void
  streaming?: boolean
  interrupted?: boolean
}
