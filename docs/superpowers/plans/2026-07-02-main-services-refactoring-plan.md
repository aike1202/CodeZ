# 主进程与服务层重构实施计划 (Main Process & Services Refactoring Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将体量较大的 `AgentRunner.ts` (684 行)、`ProjectAnalysisService.ts` (641 行) 和 `workspace.handlers.ts` (415 行) 彻底拆解为符合规范的子目录模块。

**Architecture:** 采用面向对象与控制反转组合模式，将大文件按单一职责拆解为专注于错误恢复、快照缓存、代码搜索、IPC 请求分发的独立子模块。

**Tech Stack:** Electron, Node.js, TypeScript

## Global Constraints

- 每个 TS 文件代码行数建议控制在 150 行以内，硬性上限 200 行。
- 保持对外 API 和全局 IPC 通道签名 100% 兼容。
- 每次修改后运行 `npx tsc --noEmit` 进行类型验证。

---

### Task 1: `AgentRunner` 模块化重构

**Files:**
- Create: `src/main/agent/AgentRunner/types.ts`
- Create: `src/main/agent/AgentRunner/agentErrorHandler.ts`
- Create: `src/main/agent/AgentRunner/planRunnerHelper.ts`
- Create: `src/main/agent/AgentRunner/index.ts`
- Remove: `src/main/agent/AgentRunner.ts`

**Interfaces:**
- Consumes: `ChatService`, `ToolManager`, `EditTransactionService`
- Produces: `AgentRunner` (100% 相同类接口)

- [ ] **Step 1: 创建 `AgentRunner/types.ts` 定义配置与回调接口**
- [ ] **Step 2: 创建 `AgentRunner/agentErrorHandler.ts` 处理工具错误判定与建议**
- [ ] **Step 3: 创建 `AgentRunner/planRunnerHelper.ts` 辅助 SubAgent 与 Plan Mode 联动**
- [ ] **Step 4: 创建 `AgentRunner/index.ts` 组合主类并删除原 `AgentRunner.ts`**
- [ ] **Step 5: 运行 `npx tsc --noEmit` 校验并提交 git commit**

---

### Task 2: `ProjectAnalysisService` 模块化重构

**Files:**
- Create: `src/main/services/ProjectAnalysisService/types.ts`
- Create: `src/main/services/ProjectAnalysisService/snapshotCache.ts`
- Create: `src/main/services/ProjectAnalysisService/codeSearcher.ts`
- Create: `src/main/services/ProjectAnalysisService/symbolExtractor.ts`
- Create: `src/main/services/ProjectAnalysisService/index.ts`
- Remove: `src/main/services/ProjectAnalysisService.ts`

**Interfaces:**
- Consumes: `fs/promises`, `crypto`
- Produces: `ProjectAnalysisService` (100% 相同类接口)

- [ ] **Step 1: 创建 `types.ts` 定义分析参数与快照数据结构**
- [ ] **Step 2: 创建 `snapshotCache.ts` 抽象 JSON 缓存读写逻辑**
- [ ] **Step 3: 创建 `codeSearcher.ts` 实现全局代码正则与文本搜索**
- [ ] **Step 4: 创建 `symbolExtractor.ts` 实现 TS/JS 语言符号树抽取**
- [ ] **Step 5: 创建 `index.ts` 并删除原 `ProjectAnalysisService.ts`**
- [ ] **Step 6: 运行 `npx tsc --noEmit` 校验并提交 git commit**

---

### Task 3: `workspace.handlers` 模块化重构

**Files:**
- Create: `src/main/ipc/workspace.handlers/fileOpsHandlers.ts`
- Create: `src/main/ipc/workspace.handlers/projectAnalysisHandlers.ts`
- Create: `src/main/ipc/workspace.handlers/index.ts`
- Remove: `src/main/ipc/workspace.handlers.ts`

**Interfaces:**
- Consumes: `ipcMain`, `WorkspaceService`, `ProjectAnalysisService`
- Produces: `registerWorkspaceHandlers` (100% 相同注册函数)

- [ ] **Step 1: 创建 `fileOpsHandlers.ts` 注册文件读取、写入、删除等 IPC 通道**
- [ ] **Step 2: 创建 `projectAnalysisHandlers.ts` 注册快照、符号索引、检索等 IPC 通道**
- [ ] **Step 3: 创建 `index.ts` 入口并删除原 `workspace.handlers.ts`**
- [ ] **Step 4: 运行 `npx tsc --noEmit` 校验并提交 git commit**
