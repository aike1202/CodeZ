import React from 'react'
import Flex from '../ui/Flex'
import ExecutionLog from './ExecutionLog'
import MessageBody from './MessageBody'
import EditApprovalWidget from './EditApprovalWidget'
import { extractMessageEdits, handleApprovalDiffClick } from './ChatArea' // We might need to move extractMessageEdits to a utils file?

// Wait, I will just export extractMessageEdits from ExecutionLogUtils or somewhere if needed, but for now I can import from ChatArea. Or better, move it to ChatAreaUtils.ts?

export interface AgentMessageContentProps {
  msg: any
  lastStreamingMsgId: string | null
  handleFileClick: (filePath: string, virtualContent?: string) => Promise<void>
  handleDiffClick: (
    filePath: string,
    editInfo: {
      type: 'write' | 'replace'
      targetContent?: string
      replacementContent?: string
      codeContent?: string
    }
  ) => void
}

export function AgentMessageContent({
  msg,
  lastStreamingMsgId,
  handleFileClick,
  handleDiffClick
}: AgentMessageContentProps): React.ReactElement {
  if (!msg.executionTimeline || msg.executionTimeline.length === 0) {
    return (
      <div className="agent-message-content">
        <ExecutionLog
          timeline={[]}
          reasoning={msg.reasoningContent}
          agentStates={msg.agentStates}
          onFileClick={handleFileClick}
          onDiffClick={handleDiffClick}
          streaming={msg.streaming && msg.id === lastStreamingMsgId}
        />
        <MessageBody
          content={msg.content}
          streaming={msg.streaming && msg.id === lastStreamingMsgId}
          reasoning={msg.reasoningContent}
          onFileClick={handleFileClick}
        />
      </div>
    )
  }

  const executionTimeline = msg.executionTimeline || []
  let lastNonTextIdx = -1
  for (let i = executionTimeline.length - 1; i >= 0; i--) {
    if (executionTimeline[i].type !== 'text') {
      lastNonTextIdx = i
      break
    }
  }

  const isStreaming = msg.streaming && msg.id === lastStreamingMsgId
  let timelineForLog: any[] = []
  let finalContent = ''

  if (isStreaming) {
    timelineForLog = executionTimeline
    finalContent = ''
  } else {
    timelineForLog = lastNonTextIdx === -1 ? [] : executionTimeline.slice(0, lastNonTextIdx + 1)
    timelineForLog = timelineForLog.filter((item: any) => item.type !== 'text')

    const finalTextItems = lastNonTextIdx === -1 ? executionTimeline : executionTimeline.slice(lastNonTextIdx + 1)
    finalContent = finalTextItems
      .filter((item: any) => item.type === 'text')
      .map((item: any) => (item as any).content)
      .join('')
      .trimStart()
  }

  const hasToolsOrAgentStates =
    timelineForLog.length > 0 || (msg.agentStates && msg.agentStates.length > 0) || !!msg.reasoningContent

  // Process edits
  const { edits, tools } = extractMessageEdits(msg)
  const allProcessed = edits.length > 0 && edits.every((e: any) => msg.editStatuses?.[e.filePath])

  return (
    <div className="agent-message-content">
      {hasToolsOrAgentStates && (
        <div className="app-spacer">
          <ExecutionLog
            timeline={timelineForLog}
            reasoning={msg.reasoningContent}
            agentStates={msg.agentStates}
            onFileClick={handleFileClick}
            onDiffClick={handleDiffClick}
            streaming={isStreaming && !finalContent}
          />
        </div>
      )}
      {finalContent && (
        <div className={hasToolsOrAgentStates ? 'mt-4' : ''}>
          <MessageBody content={finalContent} streaming={false} onFileClick={handleFileClick} />
        </div>
      )}

      {allProcessed && (
        <EditApprovalWidget
          msgId={msg.id}
          txId={msg.txId}
          edits={edits}
          editStatuses={msg.editStatuses}
          onDiffClick={(filePath) => handleApprovalDiffClick(filePath, tools, handleDiffClick, handleFileClick)}
          onFileClick={(filePath) => handleFileClick(filePath)}
        />
      )}
    </div>
  )
}
