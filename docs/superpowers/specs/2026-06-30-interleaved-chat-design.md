# Interleaved Chat Message Display Design (Antigravity Style)

## 1. Context & Motivation
Currently, in `AgentMessageContent.tsx`, the execution timeline is strictly divided into two distinct sections:
1. A unified `<ExecutionLog>` block at the top, capturing all tool executions and reasoning.
2. A single `<MessageBody>` block at the bottom, capturing all text responses.

This causes a problem when the AI assistant "thinks aloud" or interleaves text responses with tool calls (e.g., "I will first search for X... [Tool runs]... Found X. Now I will build Y... [Tool runs]..."). The intermediate texts are visually merged or deferred to the bottom, breaking the narrative timeline and making the UI confusing compared to state-of-the-art clients like Antigravity.

## 2. Goals
- Restructure `AgentMessageContent.tsx` to interleave text responses and tool/reasoning executions chronologically.
- Enhance `<ExecutionLog>` to handle localized chunks of executions.
- Provide smart auto-expansion and auto-collapsing for execution chunks so the user isn't overwhelmed but can still monitor running tools.

## 3. Design & Architecture

### 3.1 Timeline Chunking (AgentMessageContent)
The `executionTimeline` of a message contains items of types: `reasoning`, `tool`, and `text`.
We will iterate over `executionTimeline` and group adjacent `reasoning`/`tool` items into an "Execution Chunk", while keeping contiguous `text` items as a "Text Chunk".

Example Transformation:
**Input Timeline:** `[Text1, Text2, Tool1, Reasoning1, Tool2, Text3]`
**Chunked Output:**
- `Text Chunk: [Text1, Text2]` -> Rendered via `<MessageBody>`
- `Execution Chunk: [Tool1, Reasoning1, Tool2]` -> Rendered via `<ExecutionLog>`
- `Text Chunk: [Text3]` -> Rendered via `<MessageBody>`

### 3.2 Refactoring ExecutionLog
`<ExecutionLog>` will now accept an explicit `running` status boolean from the parent chunk logic, or compute it locally based on its subset of items and whether the entire message `isStreaming`.
- **Auto-Collapse Logic:** The existing 1.5s delay collapse will be preserved. When the chunk is actively receiving updates (or executing), it will expand. When execution moves to the next chunk or finishes, it will gracefully collapse.

### 3.3 Handling Edits Widget
The `EditApprovalWidget` (which shows the diff approvals at the end of the message) will remain at the very bottom of the message, unaffected by the chunking, as it represents the finalized state of all edits in the message transaction.

## 4. Implementation Details
1. **AgentMessageContent.tsx**:
   - Write a `chunkTimeline(timeline: ExecutionTimelineItem[])` function.
   - Map over chunks. If `chunk.type === 'text'`, extract text content and render `<MessageBody>`.
   - If `chunk.type === 'execution'`, render `<ExecutionLog timeline={chunk.items} ... />`.
2. **ExecutionLog.tsx**:
   - Ensure the internal `buildUnifiedTimeline` and expansion logic gracefully handle being instantiated multiple times per message.

## 5. Potential Pitfalls
- **Streaming State:** When streaming, the active text or active execution block must be dynamically appended without breaking the React component tree (which could cause remounting and flickering). Array indices or unique chunk IDs must be stable.
- **Empty execution logs:** If an execution chunk is somehow empty (e.g., a tool call that is skipped), it should not render a dangling `<ExecutionLog>`.
