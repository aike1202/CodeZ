import React from 'react'
import { Bot, CheckCircle2, CircleDot, LoaderCircle } from 'lucide-react'
import type { SubAgentRecord } from '../../stores/chatStore'
import SubAgentCard from '../chat/SubAgentCard'

interface SubAgentLogsPanelProps {
  subAgents: SubAgentRecord[]
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

export function SubAgentLogsPanel({
  subAgents,
  onFileClick,
  onDiffClick
}: SubAgentLogsPanelProps): React.ReactElement {
  const runningCount = subAgents.filter((agent) => agent.status === 'running').length
  const completedCount = subAgents.filter((agent) => agent.status === 'completed').length

  if (subAgents.length === 0) {
    return (
      <div className="right-agent-empty">
        <Bot size={24} strokeWidth={1.6} aria-hidden="true" />
        <span>当前会话暂无子智能体日志</span>
      </div>
    )
  }

  return (
    <div className="right-agent-logs">
      <div className="right-agent-summary" aria-label="子智能体运行概况">
        <span>
          <CircleDot size={13} aria-hidden="true" />
          共 {subAgents.length} 个
        </span>
        {runningCount > 0 && (
          <span className="right-agent-summary-running">
            <LoaderCircle size={13} className="right-agent-spin" aria-hidden="true" />
            {runningCount} 个运行中
          </span>
        )}
        {completedCount > 0 && (
          <span>
            <CheckCircle2 size={13} aria-hidden="true" />
            {completedCount} 个已完成
          </span>
        )}
      </div>

      <div className="right-agent-list">
        {subAgents.map((subAgent) => (
          <SubAgentCard
            key={subAgent.id}
            subAgent={subAgent}
            onFileClick={onFileClick}
            onDiffClick={onDiffClick}
          />
        ))}
      </div>
    </div>
  )
}

