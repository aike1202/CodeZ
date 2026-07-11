# Parallel Tool Batch Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render every multi-tool model response as one expandable “并行执行 N 项” log card while preserving each child tool row’s existing interactions.

**Architecture:** AgentRunner assigns explicit batch metadata to every tool call emitted by the same model response and carries it through IPC into `ToolCallState`. A pure renderer utility groups unified timeline items by batch ID, and a focused React component renders batch status, elapsed time, and the existing `LogItemRow` children.

**Tech Stack:** TypeScript, React 18, Zustand, Electron IPC, Vitest, CSS.

## Global Constraints

- Do not infer batches from timestamps.
- Keep single tool calls on the existing row path.
- Preserve file preview, Diff, detail expansion, status, and error interactions.
- Batch cards start expanded and do not auto-collapse when completed.
- The outer execution log keeps its existing completion auto-collapse behavior.
- Do not change tool authorization or execution semantics.
- Do not commit changes unless the user explicitly requests a commit.

---

### Task 1: Propagate Explicit Tool Batch Metadata

**Files:**
- Create: `src/shared/types/toolExecution.ts`
- Modify: `src/shared/types/index.ts`
- Modify: `src/main/agent/AgentRunner/types.ts`
- Modify: `src/main/agent/AgentRunner/index.ts`
- Modify: `src/main/ipc/chat.handlers.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/env.d.ts`
- Modify: `src/renderer/src/components/chat/hooks/useSendMessage.ts`
- Modify: `src/renderer/src/stores/chatStore/types.ts`

**Interfaces:**
- Produces: `ToolBatchMeta { batchId: string; batchIndex: number; batchSize: number }`.
- Produces: optional `batch?: ToolBatchMeta` on `onToolStart` callbacks.
- Produces: optional `batchId`, `batchIndex`, and `batchSize` on `ToolCallState`.

- [ ] **Step 1: Add the shared batch metadata type**

```ts
export interface ToolBatchMeta {
  batchId: string
  batchIndex: number
  batchSize: number
}
```

Export it from `src/shared/types/index.ts`.

- [ ] **Step 2: Extend the main-process callback contract**

Change `AgentRunnerCallbacks.onToolStart` to:

```ts
onToolStart?: (
  toolCallId: string,
  name: string,
  args: string,
  thoughtSignature?: string,
  batch?: ToolBatchMeta
) => void
```

- [ ] **Step 3: Assign one stable batch to each model response**

Immediately before notifying `onToolStart`, derive metadata only when the response contains multiple calls:

```ts
const batchId = toolCallsArray.length > 1 ? `batch_${toolCallsArray[0].id}` : undefined

toolCallsArray.forEach((toolCall, batchIndex) => {
  callbacks.onToolStart?.(
    toolCall.id,
    toolCall.function.name,
    toolCall.function.arguments,
    toolCall.thought_signature,
    batchId
      ? { batchId, batchIndex, batchSize: toolCallsArray.length }
      : undefined
  )
})
```

Do not alter the following `Promise.all` execution block.

- [ ] **Step 4: Carry metadata through IPC and preload**

Append the optional batch object to `CHAT_STREAM_TOOL_START` in `chat.handlers.ts`, accept it in the preload handler, and forward it to the renderer callback. Keep it as the final optional argument for backward compatibility.

- [ ] **Step 5: Store metadata with each tool call**

Extend `ToolCallState`:

```ts
batchId?: string
batchIndex?: number
batchSize?: number
```

In `useSendMessage.ts`, map `batch` into those three fields when calling `startToolCall`.

- [ ] **Step 6: Verify static contracts**

Run: `npm run typecheck`

Expected: TypeScript completes without new callback-signature or IPC errors.

---

### Task 2: Build and Test Batch Grouping

**Files:**
- Modify: `src/renderer/src/components/chat/ExecutionLog/utils/types.ts`
- Modify: `src/renderer/src/components/chat/ExecutionLog/utils/timelineBuilder.ts`
- Create: `src/renderer/src/components/chat/ExecutionLog/utils/batchBuilder.ts`
- Modify: `src/renderer/src/components/chat/ExecutionLog/utils/index.ts`
- Create: `src/tests/execution-log-batch-builder.test.ts`

**Interfaces:**
- Consumes: optional batch fields on `ToolCallState`.
- Produces: `ParallelToolBatchItem` and `ExecutionLogDisplayItem`.
- Produces: `groupParallelToolBatches(items)` and `getParallelBatchDuration(batch, now?)`.

- [ ] **Step 1: Write failing batch grouping tests**

Cover these exact cases:

```ts
it('groups one model response into one parallel batch')
it('keeps single and legacy items ungrouped')
it('preserves batchIndex ordering')
it('computes duration from earliest start to latest completion')
it('marks a completed batch as error when any child fails')
```

Use plain `UnifiedTimelineItem` fixtures so the tests run in the Node Vitest environment without rendering React.

- [ ] **Step 2: Run the targeted test and confirm failure**

Run: `npm test -- --run src/tests/execution-log-batch-builder.test.ts`

Expected: FAIL because the batch builder exports do not exist.

- [ ] **Step 3: Propagate batch metadata into unified items**

Add optional fields to `UnifiedTimelineItem`:

```ts
batchId?: string
batchIndex?: number
batchSize?: number
```

Every tool-derived item created by `buildUnifiedTimeline` must copy these fields from its `ToolCallState`.

- [ ] **Step 4: Implement the pure batch view model**

Define:

```ts
export interface ParallelToolBatchItem {
  id: string
  type: 'parallel-batch'
  batchId: string
  batchSize: number
  timestamp: number
  status: 'running' | 'success' | 'error'
  items: UnifiedTimelineItem[]
}

export type ExecutionLogDisplayItem = UnifiedTimelineItem | ParallelToolBatchItem
```

`groupParallelToolBatches` must emit a batch at the first matching child position, sort children by `batchIndex`, and leave items without a multi-call batch untouched. Status rules: running wins; otherwise any error yields error; otherwise success.

- [ ] **Step 5: Implement total-duration calculation**

Use each child timestamp as the start and its tool duration source as the end. To avoid parsing formatted strings, add optional `completedAt` to `UnifiedTimelineItem` and copy it from `ToolCallState`. The duration helper returns milliseconds using the latest completion or `now` while running.

- [ ] **Step 6: Run the targeted tests**

Run: `npm test -- --run src/tests/execution-log-batch-builder.test.ts`

Expected: all batch builder tests PASS.

---

### Task 3: Render the Expandable Parallel Card

**Files:**
- Create: `src/renderer/src/components/chat/ExecutionLog/components/ParallelToolBatchCard.tsx`
- Create: `src/renderer/src/components/chat/ExecutionLog/components/ParallelToolBatchCard.css`
- Modify: `src/renderer/src/components/chat/ExecutionLog/index.tsx`

**Interfaces:**
- Consumes: `ParallelToolBatchItem`, existing `LogItemRow` props, and the parent item expansion map.
- Produces: a card that owns only its batch-level expanded state and elapsed-time display.

- [ ] **Step 1: Group items before rendering**

Memoize display items after `buildUnifiedTimeline`:

```ts
const displayItems = useMemo(
  () => groupParallelToolBatches(unifiedItems),
  [unifiedItems]
)
```

Keep summary calculations based on the original `unifiedItems` so existing counts remain unchanged.

- [ ] **Step 2: Create the focused card component**

The card header copy must be:

```ts
const title = batch.status === 'running'
  ? `正在并行执行 ${batch.batchSize} 项`
  : `并行执行 ${batch.batchSize} 项`
```

Append `· ${formatMilliseconds(totalDuration)}` and, for partial failure, `· ${failedCount} 项失败`.

- [ ] **Step 3: Preserve child interactions**

Render every child with the existing `LogItemRow`, forwarding `onFileClick`, `onDiffClick`, `hasItemDetail`, `isItemExpanded`, and `toggleItemExpand`. The card must not duplicate file or detail click handlers.

- [ ] **Step 4: Keep the card expanded across status updates**

Initialize local card state with `useState(true)`. Do not add an effect that reacts to batch completion. While running, use a one-second interval solely to refresh elapsed time; clear it when completed or unmounted.

- [ ] **Step 5: Add restrained batch styling**

Use the existing panel, border, muted text, primary, and error variables. The card needs one subtle border, a compact header, a child indentation rail, keyboard-visible button focus, and no decorative gradients or new color system.

- [ ] **Step 6: Verify static and targeted behavior**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm test -- --run src/tests/execution-log-batch-builder.test.ts`

Expected: PASS.

---

### Task 4: Regression Verification

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: completed feature from Tasks 1–3.
- Produces: evidence that existing execution logs remain compatible.

- [ ] **Step 1: Run relevant store and runner tests**

Run: `npm test -- --run src/tests/agent-runner-transition.test.ts src/tests/chat-stream-v2.test.ts src/tests/execution-log-batch-builder.test.ts`

Expected: all selected tests PASS.

- [ ] **Step 2: Run the full typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: Electron Vite build completes successfully.

- [ ] **Step 4: Review the focused diff**

Run: `git diff -- src/shared/types/toolExecution.ts src/shared/types/index.ts src/main/agent/AgentRunner/types.ts src/main/agent/AgentRunner/index.ts src/main/ipc/chat.handlers.ts src/preload/index.ts src/renderer/src/env.d.ts src/renderer/src/components/chat/hooks/useSendMessage.ts src/renderer/src/stores/chatStore/types.ts src/renderer/src/components/chat/ExecutionLog src/tests/execution-log-batch-builder.test.ts`

Expected: every changed line maps directly to explicit batch metadata, grouping, card rendering, or verification.
