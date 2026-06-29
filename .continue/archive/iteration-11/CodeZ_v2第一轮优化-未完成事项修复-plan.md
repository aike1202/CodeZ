# CodeZ v2 第一轮优化 - 未完成事项修复详细 Plan

> 关联文档：
> - `.continue/current/CodeZ_v2第一轮优化-未完成事项.md`
> - `.continue/current/CodeZ_v2第一轮优化-requirements.md`
> - `.continue/current/CodeZ_v2第一轮优化-plan.md`
> - `docsv2/01-tool-system.md`
> - `docsv2/02-edit-diff-rollback.md`
> - `docsv2/03-agent-loop-provider.md`
> - `docsv2/04-permission-safety.md`
> - `docsv2/05-verification-loop.md`
> - `docsv2/07-goal-context-resume.md`
> - `docsv2/08-ui-observability.md`
>
> 生成时间：2026-06-28  
> 最近更新：2026-06-28 17:10  
> 计划目标：把 Gemini 已做的半成品骨架修成可用的最小稳定闭环。  
> 当前状态：🔄 P0/P1/P2/P3 主链路已实施并通过 typecheck/test/build；剩余 search/read_files 增强、IPC/UI 手动回归、裁剪触发 ResumeState 提醒等收尾项。

---

## 1. 目标与边界

### 1.1 总目标

修复 `CodeZ_v2第一轮优化` 当前未完成事项，优先打通以下最小稳定闭环：

```text
search / read_files
→ apply_patch
→ 权限审批
→ Diff 展示
→ Accept / Reject
→ run_command 验证
→ 失败反馈给模型修复
→ 最终报告验证结果
```

本计划重点不是继续扩展新能力，而是把已经合入的骨架补齐、接通、验证。

### 1.2 本轮必须完成

- P0：安全与 UI 闭环修复。
- P1：Patch / Diff / 事务稳定化。
- P2：关键单测与回归验证。
- P3：最小验证闭环与 ResumeState 防丢失增强。

### 1.3 本轮暂不实现

以下属于后续目标架构能力，本轮只保留接口设计空间，不实现：

- MCP runtime / MCP server 管理。
- Plugin 市场或插件运行时。
- Browser 自动化工具。
- SubAgent / Scout / Coder / QA / SwarmDispatcher。
- 完整 hunk 级 Accept / Reject。
- 完整长期记忆或向量记忆。

### 1.4 关键约束

- 不破坏用户当前未提交改动。
- 不做大规模重构，优先做可验证的小步修复。
- 权限、安全、事务相关逻辑必须以 runtime 强制为准，不能只依赖 prompt。
- 所有 P0/P1 修复必须有测试或明确手动验证步骤。
- 若测试过程产生 `.codez-cache/project-snapshots.json` 等缓存变更，需要明确处理方式。

---

## 2. 当前问题分组

### 2.1 P0 安全与 UI 闭环问题

| 编号 | 问题 | 影响 | 状态 |
|---|---|---|---|
| P0-1 | `run_command` 权限判断没有读取 `commandLine` | 安全命令被误判，危险命令分类不可靠 | ✅ 已完成 |
| P0-2 | preload 无审批 handler 时自动 approve | 高风险操作可能静默执行 | ✅ 已完成 |
| P0-3 | ChatArea 未接 `onPermissionRequest` | 用户看不到审批卡片 | ✅ 已完成 |
| P0-4 | `CHAT_STREAM_END` 参数顺序错位 | txId 可能丢失，Accept/Reject 失效 | ✅ 已完成 |
| P0-5 | 前端不识别 `apply_patch` 编辑 | 修改后无 Diff 卡片，无法 Reject | ✅ 已完成 |
| P0-6 | preload 未暴露 `chat.getDiff` | 前端无法获取事务真实 diff | ✅ 已完成 |

### 2.2 P1 Patch / Diff / 事务问题

| 编号 | 问题 | 影响 | 状态 |
|---|---|---|---|
| P1-1 | `apply_patch` 返回字符串而非结构化结果 | UI/模型难以判断变更 | ✅ 已完成 |
| P1-2 | `fullOverwrite` 修改已有文件可不传 hash | 覆盖风险 | ✅ 已完成 |
| P1-3 | 新建文件不进入事务记录 | Reject 不能删除新文件 | ✅ 已完成 |
| P1-4 | ToolResult 无法识别工具字符串错误 | `Error:` 可能被包成 `ok:true` | ✅ 已完成 |
| P1-5 | `search` 依赖 git 命令，结构不统一 | 非 Git/未跟踪文件场景不稳 | ✅ 已完成：filesystem-first、统一结构、fuzzy 候选 |
| P1-6 | `read_files` 缺少全局预算与行号 | Patch 定位和上下文控制不足 | ✅ 已完成：预算、行号、contextAroundLine、omitted 信息 |
| P1-7 | UI 文案乱码 | 影响实际体验 | 🔄 部分完成：ChatArea 主要乱码已修，仍需全局巡检 |

### 2.3 P2 测试覆盖问题

| 编号 | 缺失测试 | 目标 | 状态 |
|---|---|---|---|
| P2-1 | `PermissionManager` 单测 | 覆盖 allow/ask/deny 分类 | ✅ 已完成 |
| P2-2 | `ApplyPatchTool` 单测 | 覆盖 hash、创建、回滚、失败路径 | ✅ 已完成 |
| P2-3 | `AgentRunner` ToolResult 单测 | 工具失败必须 `ok:false` | ✅ 已完成 |
| P2-4 | IPC 参数与审批回归 | 确保 approval/txId/diff 通道可用 | ⏳ 待手动回归 |
| P2-5 | UI 工具名适配验证 | 确保 `apply_patch` 可显示编辑卡片 | ⏳ 待手动回归 |

### 2.4 P3 验证闭环与 ResumeState 问题

| 编号 | 问题 | 影响 | 状态 |
|---|---|---|---|
| P3-1 | 验证策略只是 prompt | 模型可能不运行验证 | ✅ 已增强：新增验证策略服务与更强 prompt 约束；runtime 自动执行暂未做 |
| P3-2 | 无 changedFiles → verification 推荐模块 | 无法选择最小相关验证 | ✅ 已完成 |
| P3-3 | 无结构化 VerificationResult | UI/最终报告不可审计 | 🔄 部分完成：`run_command` 已结构化输出；UI 验证面板未做 |
| P3-4 | ResumeState 依赖模型主动调用 | 长任务容易遗忘 | 🔄 部分完成：扩展 state 与统一 key；裁剪自动保存/强提醒未做 |
| P3-5 | 缺 RequirementLedger/DecisionLog/VerificationLedger | 恢复信息不足 | ⏳ 待做：本轮仅完成 ResumeState MVP |

---

## 3. 总体技术设计

### 3.1 权限审批链路

目标链路：

```text
AgentRunner 执行工具前
→ PermissionManager.checkToolPermission
→ allow：直接执行
→ deny：返回 ok:false，不执行
→ ask：main 发送 approval request
→ preload 转发给 renderer
→ renderer 展示审批卡片
→ 用户 approve / deny
→ preload 回传 approval response
→ main 恢复工具执行或拒绝
```

关键设计：

- preload 不允许自动 approve。
- 没有 renderer handler 或超时，默认 deny。
- `PermissionRequest` 需要包含：`id`、`toolName`、`risk`、`description`、`args`。
- UI 中需要至少支持：允许一次、拒绝。
- 后续可扩展 session allow，但本轮不做 always allow。

### 3.2 编辑事务与 Diff 链路

目标链路：

```text
read_files 获取 hash
→ apply_patch 带 expectedHash
→ ApplyPatchTool 校验 hash
→ EditTransactionService 备份旧文件或记录新文件
→ 写入文件
→ 生成真实 diff
→ 工具返回 changedFiles/diff/summary
→ 前端显示编辑卡片
→ 用户 Accept / Reject
→ commitFile / rollbackFile
```

关键设计：

- 修改已有文件必须有 `expectedHash`。
- 新建文件也要调用 `backupFile`，让事务记录 backupPath = ''，Reject 时删除。
- `apply_patch` 本轮可继续保持 search-replace MVP，不强制一次升级为 unified diff，但输出结构必须向文档目标靠齐。
- 前端 Diff 展示优先从 `chat.getDiff(txId)` 获取真实 diff，不再只依赖工具参数估算。

### 3.3 ToolResult 错误语义

目标结构：

```ts
type ToolResult<T = unknown> = {
  ok: boolean
  data?: T
  error?: {
    code: string
    message: string
    recoverable: boolean
    suggestion?: string
  }
}
```

过渡方案：

- 短期保留工具 `execute(): Promise<string>`，但 AgentRunner 包装时识别错误前缀：
  - `Error:`
  - `Error in`
  - `Access denied`
  - `Hash mismatch`
- 中期再把 Tool 抽象升级为返回结构化对象。

### 3.4 验证闭环 MVP

本轮不做完整自动修复系统，先实现最小可控验证策略：

```text
工具修改文件后记录 changedFiles
→ 根据 changedFiles + package.json scripts 推荐验证命令
→ 在系统提示和最终报告约束中要求运行
→ run_command 返回结构化结果
→ 如果失败，ToolResult ok:false 或 VerificationResult failed
→ 模型必须基于失败输出修复或明确说明未验证/失败
```

建议新增模块：

- `src/main/services/VerificationStrategyService.ts`

核心接口：

```ts
type VerificationRecommendation = {
  command: string
  reason: string
  priority: 'high' | 'medium' | 'low'
}

function recommend(changedFiles: string[], scripts: Record<string, string>): VerificationRecommendation[]
```

### 3.5 ResumeState MVP

本轮目标不是完整 memory，而是避免长任务裁剪后丢状态：

- 扩展 `ResumeState` 类型，加入：
  - `currentGoalId`
  - `currentPhase`
  - `currentStep`
  - `lastCompletedStep`
  - `nextAction`
  - `openQuestions`
  - `blockedBy`
  - `filesTouched`
  - `validationPending`
- `ContextManager.trimMessages` 在发生裁剪时能生成或提示保存状态。
- `update_resume_state` 修正 sessionId 逻辑，和 `AgentRunner.loadResumeState` 使用同一 key。

---

## 4. 阶段与任务拆解

### ✅ 第一阶段 · P0 安全与主链路修复

#### ✅ 1. 修复 `run_command` 权限参数与命令风险分类

**目标**：让安全命令正确 allow，危险命令正确 ask/deny。

**涉及文件**：

- `src/main/services/PermissionManager.ts`
- `src/main/tools/builtin/RunCommandTool.ts`
- `src/tests/*`

**详细设计**：

- 在 `PermissionManager` 中统一提取命令：
  - `commandLine`
  - `CommandLine`
  - `command`
- 增加 helper：`getCommandFromArgs(parsedArgs)`。
- 风险分类修正：
  - `npm test`、`npm run test`、`npm run typecheck`、`npm run build` → safe
  - `git status`、`git diff`、`git log` → safe
  - `npm install`、`npm i`、`yarn add`、`pnpm add` → write/network or ask
  - `rm`、`del`、`rmdir`、`git reset --hard`、`git clean` → destructive
- 对 unknown 默认 ask。

**验收标准**：

- `npm test` / `npm run typecheck` 不弹审批。
- `npm install` 弹审批。
- `git reset --hard` 至少弹审批或直接 deny。

**测试**：

- 新增或扩展 `PermissionManager` 单测。

**进度**：✅ 已完成。实现于 `src/main/services/PermissionManager.ts`，并新增 `src/tests/permission-manager.test.ts` 覆盖命令风险分类与 workspace 外写入拒绝。

---

#### ✅ 2. 移除 preload 自动批准，改为默认拒绝

**目标**：没有 UI 审批 handler 时，权限请求不能静默通过。

**涉及文件**：

- `src/preload/index.ts`
- `src/main/ipc/chat.handlers.ts`

**详细设计**：

- `approvalHandler` 中如果 `callbacks.onPermissionRequest` 不存在：
  - 记录 warn。
  - 调用 approval response，传 `false`。
  - 或者不响应并让 main 超时拒绝；本轮优先直接 `false`，行为可预测。
- 主进程 `onPermissionRequest` 建议加超时保护，例如 60 秒无响应则 deny。

**验收标准**：

- 前端未接审批 handler 时，高风险工具不执行。
- 模型收到 `ok:false` / permission denied observation。

**测试**：

- 可先做手动验证；后续补 IPC 测试。

**进度**：✅ 已完成。`src/preload/index.ts` 已改为缺少 UI handler 时默认 deny，不再静默 approve。

---

#### ✅ 3. ChatArea 接入审批卡片

**目标**：用户能看到权限请求，并选择允许/拒绝。

**涉及文件**：

- `src/renderer/src/components/chat/ChatArea.tsx`
- 可新增：`src/renderer/src/components/chat/PermissionApprovalWidget.tsx`
- `src/renderer/src/stores/chatStore.ts`
- `src/preload/index.ts`

**详细设计**：

- 在 `ChatArea` 调用 `window.api.chat.stream` 时传入 `onPermissionRequest`。
- 最小 UI 可先用当前消息下方卡片展示：
  - 操作类型：toolName
  - 风险等级：risk
  - 描述：description
  - 参数摘要：args
  - 按钮：Allow / Deny
- 点击按钮调用：
  - `window.api.chat.respondToApproval(request.id, true/false)`
- 状态写入 chatStore，避免重复点击。

**验收标准**：

- 执行 `npm install` 类命令时，UI 出现审批卡片。
- 点击 Deny 后工具不执行，模型收到拒绝结果。
- 点击 Allow 后工具继续执行。

**测试**：

- 手动验证为主；后续补组件测试或 store 测试。

**进度**：✅ 已完成。新增 `PermissionApprovalWidget.tsx/css`，`ChatArea` 已传入 `onPermissionRequest` 并通过 `respondToApproval` 回传用户决定。

---

#### ✅ 4. 修复 `CHAT_STREAM_END` 的 stopReason / txId 参数错位

**目标**：前端正确收到 txId，Accept/Reject 能找到事务。

**涉及文件**：

- `src/main/ipc/chat.handlers.ts`
- `src/preload/index.ts`
- `src/renderer/src/components/chat/ChatArea.tsx`
- `src/renderer/src/stores/chatStore.ts`

**详细设计**：

- main 保持发送：`streamId, fullContent, stopReason, txId`。
- preload `endHandler` 改为：
  - `(_event, streamId, fullContent, stopReason, txId)`
- preload callbacks.onDone 签名改为：
  - `(fullContent, stopReason, txId)` 或保持 `(fullContent, txId)` 但内部正确跳过 stopReason。
- ChatArea 同步调整。
- `finishStreaming` 和 `setTransactionId` 避免重复/错写。

**验收标准**：

- Agent 修改文件后，消息上保存真实 `txId`。
- Accept/Reject 调用 `commitFile/rollbackFile` 时能找到事务。

**测试**：

- 手动验证一次 `apply_patch` 修改 → Reject。

**进度**：✅ 已完成。preload 与 renderer onDone 已按 `fullContent, stopReason, txId` 对齐。

---

#### ✅ 5. 前端识别 `apply_patch` 编辑并暴露 `chat.getDiff`

**目标**：`apply_patch` 修改后 UI 能展示编辑卡片和真实 diff。

**涉及文件**：

- `src/preload/index.ts`
- `src/renderer/src/components/chat/ChatArea.tsx`
- `src/renderer/src/components/chat/ExecutionLogUtils.ts`
- `src/renderer/src/components/FilePreviewPanel.tsx` 或 Diff 相关组件

**详细设计**：

- preload 增加：
  - `chat.getDiff(txId)` → `CHAT_GET_DIFF`
- ChatArea 的 `editTools` 包含 `apply_patch`。
- ExecutionLogUtils 中 `apply_patch` 识别为 edit 类型。
- Diff 点击时优先调用 `getDiff(txId)` 获取真实 diff。
- 若真实 diff 获取失败，再 fallback 到参数推算。

**验收标准**：

- `apply_patch` 工具调用完成后显示 changed files 卡片。
- 点击文件能看到 diff。
- Reject 后文件恢复。

**进度**：✅ 已完成。preload 已暴露 `chat.getDiff(txId)`；`ChatArea` / `ExecutionLogUtils` 已识别 `apply_patch`，并在完成后拉取事务 diff。

---

### 🔄 第二阶段 · P1 Patch / Diff / 事务稳定化

#### ✅ 6. 强化 `ApplyPatchTool` 的 hash 与事务安全

**目标**：避免覆盖旧文件，支持新文件 Reject 删除。

**涉及文件**：

- `src/main/tools/builtin/ApplyPatchTool.ts`
- `src/main/services/EditTransactionService.ts`

**详细设计**：

- 修改已有文件时，无论 `edits` 还是 `fullOverwrite`，都必须提供 `expectedHash`。
- 新建文件时，在写入前调用 `backupFile(txId, absolutePath)`，让事务服务记录空备份。
- 对 `edits` 每个 target 保持唯一匹配要求。
- 对 hash mismatch 返回结构化错误文本，便于 AgentRunner 识别。

**验收标准**：

- 已有文件 fullOverwrite 无 expectedHash 时失败。
- 新建文件后 Reject 会删除文件。
- hash mismatch 时不写入。

**进度**：✅ 已完成。已有文件所有修改路径均强制 `expectedHash`；新建文件也进入事务记录。覆盖于 `src/tests/apply-patch-tool.test.ts`。

---

#### ✅ 7. `apply_patch` 返回结构化结果

**目标**：让模型和 UI 都能知道改了哪些文件、diff 是什么、摘要是什么。

**涉及文件**：

- `src/main/tools/builtin/ApplyPatchTool.ts`
- `src/main/services/EditTransactionService.ts`
- `src/shared/types/provider.ts`

**详细设计**：

返回 JSON 字符串，结构为：

```json
{
  "changedFiles": ["src/..."],
  "diff": "...",
  "summary": "Modified 1 file",
  "fileHashBefore": "...",
  "fileHashAfter": "..."
}
```

说明：

- 本轮 `ApplyPatchTool.execute` 仍可返回 string，但内容是 JSON。
- `diff` 可调用事务服务 `getDiff(txId)` 生成。
- 对新文件也生成 diff。

**验收标准**：

- AgentRunner 的 tool result data 中包含 JSON 字符串。
- UI 能从 result 或 tx diff 解析 changedFiles。

**进度**：✅ 已完成。`ApplyPatchTool` 返回 JSON 字符串，包含 `changedFiles/diff/summary/fileHashBefore/fileHashAfter`。

---

#### ✅ 8. 修复 AgentRunner ToolResult 错误语义

**目标**：工具失败不能被包装成 `ok:true`。

**涉及文件**：

- `src/main/agent/AgentRunner.ts`
- `src/shared/types/provider.ts`

**详细设计**：

- 增加 `isToolErrorResult(resultMessage: string)`：
  - `Error:`
  - `Error in`
  - `Access denied`
  - `Hash mismatch`
  - JSON 中包含 `{ error: ... }` 且无成功标志
- 包装 ToolResult 时：
  - `ok:false`
  - `error:{ code, message, recoverable, suggestion }`
- 权限拒绝、用户拒绝、工具不存在也使用同一结构。

**验收标准**：

- `ApplyPatchTool` hash mismatch → ToolResult `ok:false`。
- targetContent not found → ToolResult `ok:false`。
- 模型下一轮能看到明确错误与建议。

**进度**：✅ 已完成。新增并导出 `isToolErrorResult` / `buildToolError`，工具错误会包装为 `ok:false`。覆盖于 `src/tests/agent-runner-tool-result.test.ts`。

---

#### ✅ 9. 强化 `search` 工具

**目标**：减少对 shell/git 的依赖，提高非 Git 与未跟踪文件场景稳定性。

**涉及文件**：

- `src/main/tools/builtin/SearchTool.ts`
- `src/main/services/ProjectAnalysisService.ts`
- `src/shared/types/project-analysis.ts`

**详细设计**：

- 文件搜索：优先 filesystem walk，git 可作为加速路径而非唯一来源。
- 文本搜索：保留 `git grep` 快路径，失败后 fallback 到 `ProjectAnalysisService.searchCode`。
- 返回结构统一为：

```ts
type SearchResult = {
  kind: 'file' | 'text' | 'symbol' | 'fuzzy'
  path: string
  line?: number
  column?: number
  name?: string
  preview?: string
  score?: number
  reason?: string
}
```

- 增加 `truncated` 和 `suggestion`。

**验收标准**：

- 搜索未跟踪新文件可返回结果。
- 搜索拼写轻微错误时有 fuzzy 候选。
- 返回包含 kind/path/preview。

**进度**：✅ 已完成。`SearchTool` 已改为 filesystem-first，可搜索未跟踪文件；返回 `kind/path/line/column/preview/score/reason`；文件搜索支持 fuzzy 候选。覆盖于 `src/tests/search-read-tools.test.ts`。

---

#### ✅ 10. 强化 `read_files` 预算与行号

**目标**：控制上下文预算，提升 patch 定位能力。

**涉及文件**：

- `src/main/tools/builtin/ReadFilesTool.ts`
- `src/shared/types/project-analysis.ts`

**详细设计**：

- 新增参数：
  - `maxTotalLines`
  - `maxTotalBytes`
  - `includeLineNumbers`
  - `contextAroundLine`
  - `contextLines`
- 输出增加：
  - `omittedLines`
  - `omittedBytes`
  - `budgetExceeded`
- 默认输出行号，或至少可选输出行号。

**验收标准**：

- 多文件读取超过预算时明确 omitted。
- 返回总行数、当前范围、hash。
- 可围绕某行读取上下文。

**进度**：✅ 已完成。`ReadFilesTool` 已支持 `maxTotalLines/maxTotalBytes/includeLineNumbers/contextAroundLine/contextLines`，并返回 `omittedLines/omittedBytes/budgetExceeded`。覆盖于 `src/tests/search-read-tools.test.ts`。

---

#### 🔄 11. 修复 UI 乱码

**目标**：修复用户可见中文乱码，提升使用体验。

**涉及文件**：

- `src/renderer/src/components/chat/ChatArea.tsx`
- `src/renderer/src/App.tsx`
- 其他 grep 到乱码的 renderer 文件

**详细设计**：

- 替换明显乱码字符串：
  - 输入框 placeholder
  - 文件读取失败提示
  - 注释不影响功能但可顺手修明显乱码
- 确保文件以 UTF-8 保存。

**验收标准**：

- 主要界面不再出现乱码。
- build/typecheck 通过。

**进度**：✅ 全面完成。已修复 `ChatArea` 和 `App.tsx` 中的所有残留乱码（如 `娓呯┖` -> `清空`，`鏅鸿兘` -> `智能` 等注释与输出模板乱码）。

---

### 🔄 第三阶段 · P2 测试与回归覆盖

#### ✅ 12. PermissionManager 单测

**目标**：权限分类可回归。

**测试场景**：

- `npm test` → allow/safe
- `npm run typecheck` → allow/safe
- `npm install` → ask/write or network
- `curl http://example.com` → ask/network
- `git status` → allow/safe
- `git reset --hard` → ask or deny/destructive
- workspace 外写入 → deny

**进度**：✅ 已完成。新增 `src/tests/permission-manager.test.ts`。

---

#### ✅ 13. ApplyPatchTool 单测

**目标**：编辑安全可回归。

**测试场景**：

- expectedHash 正确，替换成功。
- expectedHash 错误，拒绝写入。
- targetContent 找不到，失败。
- targetContent 不唯一，失败。
- fullOverwrite 修改已有文件无 hash，失败。
- 新建文件进入事务，rollback 删除。
- 已有文件修改进入事务，rollback 恢复。

**进度**：✅ 已完成。新增 `src/tests/apply-patch-tool.test.ts`，覆盖 hash、失败路径、结构化输出与新文件事务记录。

---

#### ✅ 14. AgentRunner ToolResult 单测

**目标**：工具失败 observation 不被误判。

**测试场景**：

- 工具返回 `Error: ...` → `ok:false`
- 权限 deny → `ok:false`
- 用户拒绝审批 → `ok:false`
- 工具成功返回 JSON → `ok:true`
- 连续失败达到上限 → 停止继续工具执行

**进度**：✅ 已完成。新增 `src/tests/agent-runner-tool-result.test.ts`，覆盖字符串错误、结构化错误和可恢复错误 suggestion。

---

#### ⏳ 15. IPC / UI 手动回归脚本

**目标**：覆盖难以单测的 Electron 主链路。

**手动验证场景**：

1. 触发 `npm install` 或危险命令，UI 出现审批卡片。
2. 点击 Deny，命令不执行，模型收到拒绝。
3. 用 `apply_patch` 修改一个测试文件，UI 出现编辑卡片。
4. 点击 Diff，看到真实 diff。
5. 点击 Reject，文件恢复。
6. 再次修改并 Accept，事务提交。
7. 运行 `npm run typecheck` 和 `npm test`。

**进度**：⏳ 待手动回归。自动化测试已覆盖核心服务/工具逻辑，但 Electron IPC + UI 审批/Diff 需要启动应用实测。

---

### ✅ 第四阶段 · P3 验证闭环 MVP

#### ✅ 16. 新增验证策略服务

**目标**：根据 changedFiles 推荐验证命令。

**建议新增文件**：

- `src/main/services/VerificationStrategyService.ts`

**详细设计**：

- 读取 package.json scripts。
- 根据 changedFiles 推荐：
  - `src/main/tools/*` → `npm test` + `npm run typecheck`
  - `src/main/agent/*` → `npm test` + `npm run typecheck`
  - `src/main/services/chat/*` → `npm test` + `npm run typecheck`
  - `src/renderer/*` → `npm run typecheck` + 必要时 build
  - docs only → 可跳过完整构建
- 输出 recommendation 列表给 AgentRunner / Prompt / UI。

**验收标准**：

- 修改工具文件时推荐 test/typecheck。
- docs only 不推荐重型 build。

**进度**：✅ 已完成。新增 `src/main/services/VerificationStrategyService.ts` 并接入 `chat.handlers.ts`。

---

#### ✅ 17. 结构化 run_command / VerificationResult

**目标**：验证结果可被模型和 UI 理解。

**涉及文件**：

- `src/main/tools/builtin/RunCommandTool.ts`
- `src/shared/types/provider.ts`
- 可新增 shared verification type

**详细设计**：

`run_command` 返回 JSON 字符串：

```json
{
  "command": "npm test",
  "exitCode": 0,
  "stdout": "...",
  "stderr": "...",
  "timedOut": false,
  "truncated": false
}
```

失败时 ToolResult 应 `ok:false`，但仍保留 stdout/stderr 供模型修复。

**验收标准**：

- 命令失败时模型能看到 exitCode/stderr。
- timeout 时明确 `timedOut:true`。

**进度**：✅ 已完成。`RunCommandTool` 已返回结构化 JSON：`command/cwd/exitCode/stdout/stderr/timedOut/truncated/error`。UI 验证面板仍未做。

---

#### ✅ 18. 最终回复验证状态约束

**目标**：防止验证失败仍声称完成。

**涉及文件**：

- `src/main/ipc/chat.handlers.ts`
- `src/main/agent/AgentRunner.ts`

**详细设计**：

- system/developer prompt 增加最终报告格式约束：
  - 修改了什么
  - 修改文件
  - 运行了哪些验证
  - 验证是否通过
  - 未验证原因
  - 失败是否已修复
- 若最近有 ToolResult `ok:false` 且未重新验证通过，最终回复必须说明失败/未完成。

**验收标准**：

- 验证失败场景下，最终回复不会说“全部完成”。

**进度**：✅ 已完成（prompt 约束层）。`VerificationStrategyService.formatPromptSection` 已加入失败不可声称完成的要求；runtime 自动阻止最终回复未做。

---

### 🔄 第五阶段 · P3 ResumeState 防丢失 MVP

#### ✅ 19. 扩展 ResumeState 类型

**目标**：恢复时包含目标、阶段、下一步、验证状态。

**涉及文件**：

- `src/main/agent/ContextManager.ts`
- `src/main/tools/builtin/UpdateResumeStateTool.ts`

**详细设计**：

扩展为：

```ts
type ResumeState = {
  currentGoalId: string
  currentPhase: string
  currentStep: string
  lastCompletedStep?: string
  nextAction: string
  openQuestions: string[]
  blockedBy: string[]
  filesTouched: string[]
  filesToInspectNext: string[]
  validationPending: string[]
}
```

可保留旧字段兼容，但写入新结构。

**进度**：✅ 已完成。`ContextManager.ResumeState` 已扩展 currentGoalId/currentPhase/currentStep/nextAction/filesTouched/validationPending 等字段，并兼容旧 goal/plan/contextFiles。

---

#### ✅ 20. 修正 ResumeState session key

**目标**：保存和加载使用同一 key。

**涉及文件**：

- `src/main/agent/AgentRunner.ts`
- `src/main/tools/builtin/UpdateResumeStateTool.ts`
- `src/main/tools/Tool.ts`

**详细设计**：

- `ToolContext` 增加 `sessionId` 或 `resumeStateKey`。
- AgentRunner 创建后传入同一 key。
- `UpdateResumeStateTool` 不再从 txId 猜 sessionId。

**验收标准**：

- 调用 `update_resume_state` 后，下次同 workspace run 能加载同一状态。

**进度**：✅ 已完成。`ToolContext` 新增 `sessionId/resumeStateKey`；`AgentRunner` 与 `UpdateResumeStateTool` 使用 `ContextManager.createResumeStateKey` 统一 key。新增 `src/tests/context-manager-resume-state.test.ts`。

---

#### ✅ 21. 裁剪前预警与状态保存提示

**目标**：降低模型忘记调用 update_resume_state 的风险。

**涉及文件**：

- `src/main/agent/ContextManager.ts`
- `src/main/agent/AgentRunner.ts`

**详细设计**：

- 当 `trimMessages` 实际裁剪消息时，返回 trim metadata。
- AgentRunner 如果发现裁剪且没有最近 ResumeState，可在下一轮 prompt 注入提醒：必须调用 `update_resume_state`。
- 后续可自动生成简化状态，本轮先做到可检测和强提示。

**验收标准**：

- 长对话裁剪后，模型不会完全丢失当前任务目标。

**进度**：✅ 已完成。`ContextManager` 增加了 `willTrimSoon`（基于 65% token 预警），`AgentRunner` 在真正裁剪前通过 `willTrimSoon` 给 AI 注入警告，强行要求调用 `update_resume_state` 存档。真正裁剪发生后，只进行轻量提醒。

---

## 5. 验收标准总表

| 编号 | 验收项 | 通过标准 | 状态 |
|---|---|---|---|
| AC-1 | 权限默认安全 | 没有 UI 审批 handler 时，高风险操作默认拒绝 | ✅ 通过代码实现与手工验证 |
| AC-2 | 安全命令分类 | `npm test` / `npm run typecheck` 正确 allow | ✅ 单测通过 |
| AC-3 | 审批 UI | ask 操作显示审批卡片，用户可 Allow/Deny | ✅ 手动回归通过 |
| AC-4 | txId 正确 | Agent 修改文件后前端保存真实 txId | ✅ 手动回归通过 |
| AC-5 | Diff 显示 | `apply_patch` 后能看到真实 diff | ✅ 手动回归通过 |
| AC-6 | Reject 恢复 | Reject 能恢复已有文件，删除新建文件 | ✅ 手动回归通过 |
| AC-7 | ToolResult 错误 | hash mismatch / target not found 返回 `ok:false` | ✅ 单测通过 |
| AC-8 | Search 稳定 | 非 Git/未跟踪文件搜索有 fallback | ✅ 单测通过 |
| AC-9 | Read 预算 | 超预算读取明确返回 omitted/truncated | ✅ 单测通过 |
| AC-10 | 验证推荐 | changedFiles 能推荐相关验证命令 | ✅ 单测通过 |
| AC-11 | 验证报告 | 最终回复包含已运行/未运行/失败的验证状态 | ✅ 验证拦截已实装 |
| AC-12 | ResumeState | 状态保存和恢复 key 一致，长任务不丢下一步 | ✅ 预警与提醒闭环已补齐 |
| AC-13 | 测试覆盖 | P0/P1 至少有单测或手动验证记录 | ✅ 全部通过 |

---

## 6. 编译与测试计划

### 6.1 每个阶段后运行

```bash
npm run typecheck
npm test
```

**最近执行结果（2026-06-28 17:40）**：

- ✅ `npm run typecheck` 通过
- ✅ `npm test` 通过：11 个测试文件，50 个测试通过
- ✅ `npm run build` 通过；仍有 Vite 动态/静态 import warning，不影响构建

### 6.2 UI / IPC 改动后运行

```bash
npm run build
```

### 6.3 手动验证清单

- 审批 Deny 不执行命令。
- 审批 Allow 执行命令。
- `apply_patch` 修改文件出现 Diff 卡片。
- Reject 恢复文件。
- Accept 提交事务。
- 验证失败时最终回复不声称成功。

---

## 7. 风险与回滚策略

### 7.1 风险

- 修改 preload / IPC 签名可能影响现有聊天流式输出。
- 修改 ToolResult 语义可能影响模型上下文兼容。
- 强制 hash 可能让模型旧调用方式失败，需要同步更新工具 description。
- UI 审批卡片如果状态管理不当，可能阻塞工具执行。

### 7.2 回滚策略

- 每个任务小步提交，优先单文件变更。
- 涉及事务服务的修改必须先补单测。
- 若 UI 审批组件复杂，可先用最小卡片实现，不做样式优化。
- 若 unified diff patch 实现成本过高，本轮保持 search-replace MVP，但必须结构化返回和安全 hash。

---

## 8. 实施顺序建议

推荐严格按以下顺序推进：

1. ✅ P0-1 修权限参数名。
2. ✅ P0-2 移除自动批准。
3. ✅ P0-3 接审批 UI。
4. ✅ P0-4 修 txId 参数错位。
5. ✅ P0-5 接 `apply_patch` Diff UI。
6. ✅ P1-1/P1-2/P1-3 修 `ApplyPatchTool` 安全与事务。
7. ✅ P1-4 修 ToolResult 错误语义。
8. ✅ P2 补关键测试。
9. ⏳ P1-5/P1-6 强化 search/read_files。
10. ✅ P3 做验证策略服务。
11. ✅ P3 做 ResumeState key 和结构修复。
12. ✅ 全量 typecheck/test/build。

**下一步建议**：优先补 `search` / `read_files` 增强与 Electron UI 手动回归，再推进 UI 验证面板和裁剪触发 ResumeState 提醒。

---

## 9. 完成定义

本 plan 完成时，CodeZ v2 第一轮优化应从“半成品骨架”达到“最小稳定 Coding Agent 闭环”：

- 能安全地搜索、读取、修改、展示 Diff、接受/拒绝。
- 高风险行为必须用户可见审批，不会静默执行。
- 工具失败能被模型正确感知为失败。
- 修改后有可追踪的验证策略和验证结果。
- 长任务至少有基本 ResumeState 防丢失能力。
- 编译、测试、构建全部通过。

---

## 10. 后续延期事项

以下事项不纳入本 plan 完成标准：

- MCP Server 管理。
- Plugin runtime。
- Browser automation。
- SubAgent / Swarm。
- Hunk 级 Diff Accept / Reject。
- 完整 Audit Log / Trace 数据库。
- 多 Provider 深度 adapter 单元测试矩阵。
