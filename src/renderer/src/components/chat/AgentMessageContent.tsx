import React, { useMemo } from 'react'
import ExecutionLog from './ExecutionLog'
import MessageBody from './MessageBody'
import EditApprovalWidget from './EditApprovalWidget'
import { AlertTriangle } from 'lucide-react'
import { extractMessageEdits, handleApprovalDiffClick } from './ChatArea' // We might need to move extractMessageEdits to a utils file?
import type { ChatMessage, ExecutionTimelineItem } from '../../stores/chatStore'

// Wait, I will just export extractMessageEdits from ExecutionLogUtils or somewhere if needed, but for now I can import from ChatArea. Or better, move it to ChatAreaUtils.ts?

export interface AgentMessageContentProps {
  msg: ChatMessage
  lastStreamingMsgId: string | null
  showParallelExecution?: boolean
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
  showParallelExecution = false,
  handleFileClick,
  handleDiffClick
}: AgentMessageContentProps): React.ReactElement {
  
  const isStreaming = Boolean(msg.streaming && msg.id === lastStreamingMsgId)
  const isStarting = isStreaming && msg.streamPhase === 'starting'

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
  const firstExecutionChunkIndex = chunks.findIndex((chunk) => chunk.type === 'execution')

  return (
    <div className="agent-message-content" style={{ minWidth: 0, width: '100%' }}>
      {isStreaming && chunks.length === 0 && !msg.content && !legacyExecution && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 2px',
            fontSize: '14px',
            color: 'var(--text-tertiary, #999)'
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            style={{ animation: 'spin 0.8s linear infinite' }}
            aria-hidden="true"
          >
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="3"
              fill="none"
              strokeLinecap="round"
              strokeDasharray="40 60"
            />
          </svg>
          <span>{isStarting ? '正在启动…' : '正在思考…'}</span>
        </div>
      )}

      {legacyExecution && (
        <div className="app-spacer mb-4" style={{ minWidth: 0, width: '100%' }}>
          <ExecutionLog
            timeline={[]}
            reasoning={msg.reasoningContent}
            agentStates={msg.agentStates}
            toolCalls={msg.toolCalls}
            onFileClick={handleFileClick}
            onDiffClick={handleDiffClick}
            streaming={isStreaming && !msg.content}
            interrupted={msg.interrupted}
            subAgents={msg.subAgents}
            showParallelExecution={showParallelExecution}
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
            <div key={idx} className="mb-4" style={{ minWidth: 0, width: '100%' }}>
              <MessageBody content={chunk.content} streaming={chunk.streaming} onFileClick={handleFileClick} />
            </div>
          )
        } else {
          return (
            <div key={idx} className="app-spacer mb-4" style={{ minWidth: 0, width: '100%' }}>
              <ExecutionLog
                timeline={chunk.items}
                reasoning={idx === 0 ? msg.reasoningContent : undefined} // Only pass legacy reasoning to first block if any
                agentStates={idx === 0 ? msg.agentStates : undefined}
                toolCalls={msg.toolCalls}
                onFileClick={handleFileClick}
                onDiffClick={handleDiffClick}
                streaming={chunk.streaming}
                interrupted={msg.interrupted}
                subAgents={msg.subAgents}
                showParallelExecution={showParallelExecution && idx === firstExecutionChunkIndex}
              />
            </div>
          )
        }
      })}

      {msg.responseWaitWarning && (
        <div className="agent-response-wait-warning" role="status" aria-live="polite">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>长时间未收到响应（90s），可能网络或服务异常。建议点击停止按钮后重试。</span>
        </div>
      )}

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
