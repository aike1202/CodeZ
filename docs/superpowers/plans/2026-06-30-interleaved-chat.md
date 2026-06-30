# Interleaved Chat Message Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `AgentMessageContent.tsx` to group the execution timeline into interleaved "Execution Chunks" and "Text Chunks" to mimic Antigravity's continuous chronological display.

**Architecture:** We will implement a chunking function that iterates over `msg.executionTimeline`. When contiguous `text` items are found, they form a text chunk. When contiguous `reasoning` or `tool` items are found, they form an execution chunk. These chunks are rendered sequentially in React, replacing the older logic that dumped all non-text items at the top and all text items at the bottom.

**Tech Stack:** React, TypeScript, Tailwind CSS

## Global Constraints

None specific beyond strict TypeScript adherence.

---

### Task 1: Refactor AgentMessageContent to support chunks

**Files:**
- Modify: `src/renderer/src/components/chat/AgentMessageContent.tsx`

**Interfaces:**
- Consumes: `ChatMessage`, `ExecutionTimelineItem`
- Produces: Rendering of interleaved `ExecutionLog` and `MessageBody`.

- [ ] **Step 1: Write chunking logic and modify render**

```tsx
import React, { useMemo } from 'react'
import ExecutionLog from './ExecutionLog'
import MessageBody from './MessageBody'
import EditApprovalWidget from './EditApprovalWidget'
import { extractMessageEdits, handleApprovalDiffClick } from './ChatArea'
import type { ChatMessage, ExecutionTimelineItem } from '../../stores/chatStore'

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
  
  const isStreaming = msg.streaming && msg.id === lastStreamingMsgId

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
          content={msg.content}
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
```

- [ ] **Step 2: Run build to verify types pass**

Run: `npx tsc --noEmit`
Expected: Passes with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/chat/AgentMessageContent.tsx
git commit -m "feat(chat): implement timeline chunking for interleaved display"
```
