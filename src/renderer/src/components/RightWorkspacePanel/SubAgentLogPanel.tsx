import React from 'react'
import type { SubAgentRecord } from '../../stores/chatStore'
import SubAgentCard from '../chat/SubAgentCard'

interface SubAgentLogPanelProps {
  subAgent: SubAgentRecord
  onFileClick: (filePath: string, virtualContent?: string) => void
  onDiffClick: (
    filePath: string,
    editInfo: {
      type: 'write' | 'replace'
      targetContent?: string
      replacementContent?: string
      codeContent?: string
    }
  ) => void
}

export function SubAgentLogPanel({
  subAgent,
  onFileClick,
  onDiffClick
}: SubAgentLogPanelProps): React.ReactElement {
  return (
    <div className="right-agent-log">
      <SubAgentCard
        subAgent={subAgent}
        defaultExpanded
        onFileClick={onFileClick}
        onDiffClick={onDiffClick}
      />
    </div>
  )
}

