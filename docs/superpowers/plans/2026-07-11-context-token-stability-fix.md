# Context Token Stability Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 阻止单条工具输出导致上下文瞬时膨胀，修复 Compaction Schema 重试风暴，并让 UI 区分本轮请求与原始持久化历史。

**Architecture:** 工具层限制 `Glob` 展示数量，模型上下文层对所有工具结果应用不受最近尾部保护影响的动态单条上限。Compaction 使用有界输入、完整 JSON 骨架、一次修复重试和实例级熔断；预算快照加入原始历史与 Provider 校准字段。

**Tech Stack:** TypeScript 5.5、Electron 31、React 18、Zustand 5、Vitest 1.6、Node.js crypto/fs

## Global Constraints

- 不修改或删除既有账本和 UI Session 历史。
- 不新增 tokenizer 或第三方依赖。
- 模型可见清理必须保持 tool call/result 协议配对。
- `Glob` 默认展示 1,000 条，最大允许 5,000 条。
- 单条工具模型预算为 `min(8,000, usableInputBudget * 10%)` tokens。
- Schema 修复最多一次；当前 Agent run 内第二次失败后熔断。
- PowerShell 中文输出和文件读取使用 UTF-8。
- 未获得明确提交授权时不执行 Git commit。

---

### Task 1: 修复最近尾部超大工具输出

**Files:**
- Modify: `src/main/services/context/ToolOutputPruner.ts`
- Modify: `src/main/services/context/ModelContextBuilder.ts`
- Test: `src/tests/tool-output-pruner.test.ts`
- Test: `src/tests/model-context-builder.test.ts`

**Interfaces:**
- Consumes: `usableInputBudget`、`protectedTailStart`、`NormalizedModelMessage[]`。
- Produces: `ToolOutputPruneOptions.maxSingleToolTokens`；不修改源数组的两阶段清理结果。

- [ ] **Step 1: 添加失败测试**

在 `tool-output-pruner.test.ts` 添加最新保护区内 600,000 字符 Glob 结果仍被清理的测试；在 `model-context-builder.test.ts` 添加持久化最新超大工具结果后最终预算显著下降的集成测试。

- [ ] **Step 2: 运行失败测试**

Run: `npm.cmd test -- src/tests/tool-output-pruner.test.ts src/tests/model-context-builder.test.ts`

Expected: 保护尾部结果仍保留原内容，测试失败。

- [ ] **Step 3: 实现两阶段清理**

给 `ToolOutputPruneOptions` 增加 `maxSingleToolTokens`。先扫描全部合法工具结果并清理超过该值的消息，再仅对 `protectedTailStart` 之前的候选执行目标预算清理。`ModelContextBuilder` 使用 `Math.min(8_000, Math.floor(usableInputBudget * 0.1))`。

- [ ] **Step 4: 运行测试**

Run: `npm.cmd test -- src/tests/tool-output-pruner.test.ts src/tests/model-context-builder.test.ts`

Expected: PASS。

---

### Task 2: 限制 Glob 返回数量

**Files:**
- Modify: `src/main/tools/builtin/GlobTool.ts`
- Modify: `src/tests/glob-tool.test.ts`

**Interfaces:**
- Consumes: `GlobArgs.head_limit?: number`。
- Produces: 最多 N 条路径及稳定截断说明。

- [ ] **Step 1: 添加 1,500 文件失败测试**

创建 1,500 个匹配文件，断言默认结果只包含 1,000 条路径，并包含 `showing 1000 of 1500`；另断言 `head_limit: 10` 生效。

- [ ] **Step 2: 运行失败测试**

Run: `npm.cmd test -- src/tests/glob-tool.test.ts`

Expected: 当前实现返回全部 1,500 条，测试失败。

- [ ] **Step 3: 实现参数校验与截断提示**

默认值 1,000；对非有限数回退默认值；整数限制到 1..5,000。只格式化前 N 条，超限时追加总数和缩小 `pattern`/`path` 提示。

- [ ] **Step 4: 运行测试**

Run: `npm.cmd test -- src/tests/glob-tool.test.ts`

Expected: PASS。

---

### Task 3: 修复 Compaction Schema 和重试风暴

**Files:**
- Modify: `src/main/services/context/CompactionSummary.ts`
- Modify: `src/main/services/context/CompactionModelClient.ts`
- Modify: `src/main/services/context/CompactionService.ts`
- Modify: `src/tests/compaction-summary.test.ts`
- Modify: `src/tests/compaction-service.test.ts`

**Interfaces:**
- Consumes: `validationFeedback?`、`previousInvalidOutput?`。
- Produces: 完整 JSON 骨架提示、一次修复重试、实例级 `terminalFailure` 熔断。

- [ ] **Step 1: 添加失败测试**

测试 prompt 明确包含 `"version": 1`、完整 `goal/status` 对象骨架；测试首次无效第二次有效时成功；测试连续两次无效后再次调用不增加模型调用次数。

- [ ] **Step 2: 运行失败测试**

Run: `npm.cmd test -- src/tests/compaction-summary.test.ts src/tests/compaction-service.test.ts`

Expected: 缺少骨架、修复调用和熔断，测试失败。

- [ ] **Step 3: 实现有界摘要输入和一次修复**

在摘要前对 head 应用动态单条清理。首次 `parseAndValidateSummary` 失败时，用校验信息和最多 32,000 字符的旧输出发起一次修复；第二次失败写入一个失败事件并缓存结果。后续调用直接返回缓存失败。

- [ ] **Step 4: 运行测试**

Run: `npm.cmd test -- src/tests/compaction-summary.test.ts src/tests/compaction-service.test.ts`

Expected: PASS。

---

### Task 4: Provider 实际用量与 UI 双口径

**Files:**
- Modify: `src/shared/types/context.ts`
- Modify: `src/main/services/context/ContextBudgetService.ts`
- Modify: `src/main/services/context/ModelContextBuilder.ts`
- Modify: `src/main/agent/AgentRunner/index.ts`
- Modify: `src/renderer/src/components/ContextTracker.tsx`
- Modify: `src/tests/context-budget-service.test.ts`
- Modify: `src/tests/agent-runner-ledger-authoritative.test.ts`

**Interfaces:**
- Produces: `ContextBudgetSnapshot.rawHistoryTokens`、`providerAdjustmentTokens` 和 `ContextBudgetService.applyProviderUsage()`。

- [ ] **Step 1: 添加失败测试**

预算服务测试 Provider 295,000 输入覆盖 177,000 启发式值并产生校准差额；Builder 测试 raw history 大于清理后的 recent history；Runner 测试收到 usage 后再次发送 Provider 来源预算快照。

- [ ] **Step 2: 运行失败测试**

Run: `npm.cmd test -- src/tests/context-budget-service.test.ts src/tests/model-context-builder.test.ts src/tests/agent-runner-ledger-authoritative.test.ts`

Expected: 新字段和校准方法不存在，测试失败。

- [ ] **Step 3: 实现预算校准和 UI**

所有启发式快照初始化 `providerAdjustmentTokens: 0`。Builder 在清理前计算 `rawHistoryTokens`，清理后保留该值。Runner 在当前请求 usage 到达后调用 `applyProviderUsage()` 并推送第二份快照。ContextTracker 主值使用 `totalInputTokens`，新增“原始持久化历史”和非零“Provider 校准”行。

- [ ] **Step 4: 运行测试**

Run: `npm.cmd test -- src/tests/context-budget-service.test.ts src/tests/model-context-builder.test.ts src/tests/agent-runner-ledger-authoritative.test.ts`

Expected: PASS。

---

### Task 5: 全量验收

**Files:**
- Review: all files above

- [ ] **Step 1: 运行上下文与工具回归组**

Run: `npm.cmd test -- src/tests/tool-output-pruner.test.ts src/tests/model-context-builder.test.ts src/tests/glob-tool.test.ts src/tests/compaction-summary.test.ts src/tests/compaction-service.test.ts src/tests/context-budget-service.test.ts src/tests/agent-runner-ledger-authoritative.test.ts`

Expected: PASS。

- [ ] **Step 2: 运行全量测试**

Run: `npm.cmd test`

Expected: 全部 PASS。

- [ ] **Step 3: 类型检查和构建**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run build`

Expected: Electron main、preload、renderer 全部成功。

- [ ] **Step 4: 静态审计**

Run: `rg -n "621396|COMPACTION_SCHEMA_INVALID|head_limit|maxSingleToolTokens|rawHistoryTokens|providerAdjustmentTokens" src docs/superpowers`

Expected: 新能力只出现在设计、实现与测试位置，无硬编码会话数据。

