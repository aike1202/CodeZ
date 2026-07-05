import type { AgentState, ExecutionTimelineItem, SubAgentRecord } from '../../../stores/chatStore'

export interface ExecutionLogProps {
  timeline?: ExecutionTimelineItem[]
  reasoning?: string
  agentStates?: AgentState[]
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
  subAgents?: SubAgentRecord[]
}
