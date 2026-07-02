# 状态管理与工具库重构实施计划 (State & Utilities Refactoring Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将体量较大的 `chatStore.ts` (814 行) 与 `ExecutionLogUtils.ts` (497 行) 重构拆解为符合工程规范（单文件 < 150 行）的子模块目录。

**Architecture:** 采用 Zustand Slice Pattern 对全局 store 进行领域拆分，工具函数库采用单一职责文件拆分与统一索引导出。

**Tech Stack:** TypeScript, React, Zustand

## Global Constraints

- 每个 TS/TSX 文件行数建议在 150 行以内，硬性上限 200 行。
- 对外 Hook/函数接口保持 100% 兼容。
- 每次修改后运行 `npx tsc --noEmit` 校验类型。

---

### Task 1: `chatStore` 状态模块化重构

**Files:**
- Create: `src/renderer/src/stores/chatStore/types.ts`
- Create: `src/renderer/src/stores/chatStore/slices/sessionSlice.ts`
- Create: `src/renderer/src/stores/chatStore/slices/messageSlice.ts`
- Create: `src/renderer/src/stores/chatStore/slices/approvalSlice.ts`
- Create: `src/renderer/src/stores/chatStore/index.ts`
- Remove: `src/renderer/src/stores/chatStore.ts`

**Interfaces:**
- Consumes: Zustand `create`
- Produces: `useChatStore` (100% 相同 API)

- [ ] **Step 1: 创建 `chatStore/types.ts` 定义接口与状态类型**
- [ ] **Step 2: 创建 `chatStore/slices/sessionSlice.ts` 管理会话列表**
- [ ] **Step 3: 创建 `chatStore/slices/messageSlice.ts` 管理消息收发与 IPC**
- [ ] **Step 4: 创建 `chatStore/slices/approvalSlice.ts` 管理用户审批交互**
- [ ] **Step 5: 创建 `chatStore/index.ts` 并删除旧 `chatStore.ts`**
- [ ] **Step 6: 运行 `npx tsc --noEmit` 校验并提交 git commit**

---

### Task 2: `ExecutionLogUtils` 工具库拆分

**Files:**
- Create: `src/renderer/src/components/chat/ExecutionLog/utils/types.ts`
- Create: `src/renderer/src/components/chat/ExecutionLog/utils/timelineBuilder.ts`
- Create: `src/renderer/src/components/chat/ExecutionLog/utils/itemParsers.ts`
- Create: `src/renderer/src/components/chat/ExecutionLog/utils/summaryFormatter.ts`
- Create: `src/renderer/src/components/chat/ExecutionLog/utils/iconMapper.tsx`
- Create: `src/renderer/src/components/chat/ExecutionLog/utils/index.ts`
- Remove: `src/renderer/src/components/chat/ExecutionLogUtils.ts`

**Interfaces:**
- Consumes: Icons, Types
- Produces: `buildUnifiedTimeline`, `buildFallbackTimeline`, `buildCommandItems`, `buildEditItems`, `buildSummaryText`, `getFileIconComponent`

- [ ] **Step 1: 创建 `types.ts`, `iconMapper.tsx`, `summaryFormatter.ts`, `itemParsers.ts`, `timelineBuilder.ts`**
- [ ] **Step 2: 创建 `index.ts` 入口并更新相关导入引用**
- [ ] **Step 3: 删除旧 `ExecutionLogUtils.ts`**
- [ ] **Step 4: 运行 `npx tsc --noEmit` 校验并提交 git commit**
