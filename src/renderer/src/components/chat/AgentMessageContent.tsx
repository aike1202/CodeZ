import React, { useMemo } from 'react'
import ExecutionLog from './ExecutionLog'
import MessageBody from './MessageBody'
import EditApprovalWidget from './EditApprovalWidget'
import { extractMessageEdits, handleApprovalDiffClick } from './ChatArea' // We might need to move extractMessageEdits to a utils file?
import type { ChatMessage, ExecutionTimelineItem } from '../../stores/chatStore'

// Wait, I will just export extractMessageEdits from ExecutionLogUtils or somewhere if needed, but for now I can import from ChatArea. Or better, move it to ChatAreaUtils.ts?

export interface AgentMessageContentProps {
  msg: ChatMessage
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

type TimelineChunk = 
  | { type: 'text', content: string, streaming: boolean }
  | { type: 'execution', items: ExecutionTimelineItem[], streaming: boolean }

export function AgentMessageContent({
  msg,
  lastStreamingMsgId,
  handleFileClick,
  handleDiffClick
}: AgentMessageContentProps): React.ReactElement {
  
  const isStreaming = Boolean(msg.streaming && msg.id === lastStreamingMsgId)

  const chunks = useMemo(() => {
    if (!msg.executionTimeline || msg.executionTimeline.length === 0) {
      if (msg.reasoningContent || (msg.agentStates && msg.agentStates.length > 0)) {
        return [{ type: 'execution', items: [], streaming: isStreaming }] as TimelineChunk[]
      }
      return []
    }

    const result: TimelineChunk[] = []
    let currentExecutionChunk: ExecutionTimelineItem[] = []
    let currentTextChunk: string[] = []

    for (let i = 0; i < msg.executionTimeline.length; i++) {
      const item = msg.executionTimeline[i]
      if (item.type === 'text') {
        if (currentExecutionChunk.length > 0) {
          result.push({ type: 'execution', items: currentExecutionChunk, streaming: false })
          currentExecutionChunk = []
        }
        currentTextChunk.push((item as any).content)
      } else {
        if (currentTextChunk.length > 0) {
          result.push({ type: 'text', content: currentTextChunk.join('').trimStart(), streaming: false })
          currentTextChunk = []
        }
        currentExecutionChunk.push(item)
      }
    }

    if (currentExecutionChunk.length > 0) {
      result.push({ type: 'execution', items: currentExecutionChunk, streaming: isStreaming })
    }
    if (currentTextChunk.length > 0) {
      result.push({ type: 'text', content: currentTextChunk.join('').trimStart(), streaming: isStreaming })
    }

    return result
  }, [msg.executionTimeline, msg.reasoningContent, msg.agentStates, isStreaming])

  const { edits, tools } = extractMessageEdits(msg)
  const allProcessed = edits.length > 0 && edits.every((e: { filePath: string }) => msg.editStatuses?.[e.filePath])

  // Legacy fallback if no executionTimeline but has agentStates or reasoningContent
  const legacyExecution = (!msg.executionTimeline || msg.executionTimeline.length === 0) && (msg.reasoningContent || (msg.agentStates && msg.agentStates.length > 0))

  return (
    <div className="agent-message-content">
      {legacyExecution && (
        <div className="app-spacer mb-4">
          <ExecutionLog
            timeline={[]}
            reasoning={msg.reasoningContent}
            agentStates={msg.agentStates}
            onFileClick={handleFileClick}
            onDiffClick={handleDiffClick}
            streaming={isStreaming && !msg.content}
          />
        </div>
      )}

      {chunks.length === 0 && msg.content && (
        <MessageBody
          content={msg.content || ''}
          streaming={isStreaming}
          reasoning={msg.reasoningContent}
          onFileClick={handleFileClick}
        />
      )}

      {chunks.map((chunk, idx) => {
        if (chunk.type === 'text') {
          return (
            <div key={idx} className="mb-4">
              <MessageBody content={chunk.content} streaming={chunk.streaming} onFileClick={handleFileClick} />
            </div>
          )
        } else {
          return (
            <div key={idx} className="app-spacer mb-4">
              <ExecutionLog
                timeline={chunk.items}
                reasoning={idx === 0 ? msg.reasoningContent : undefined} // Only pass legacy reasoning to first block if any
                agentStates={idx === 0 ? msg.agentStates : undefined}
                onFileClick={handleFileClick}
                onDiffClick={handleDiffClick}
                streaming={chunk.streaming}
              />
            </div>
          )
        }
      })}

      {allProcessed && (
        <EditApprovalWidget
          msgId={msg.id}
          txId={msg.txId || ''}
          edits={edits}
          editStatuses={msg.editStatuses}
          onDiffClick={(filePath) => handleApprovalDiffClick(filePath, tools, handleDiffClick, handleFileClick)}
          onFileClick={(filePath) => handleFileClick(filePath)}
        />
      )}
    </div>
  )
}
