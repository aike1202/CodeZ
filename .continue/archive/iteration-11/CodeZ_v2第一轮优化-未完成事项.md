# CodeZ v2 第一轮优化 - 未完成事项与问题清单

> 生成时间：2026-06-28  
> 来源：对 `docsv2/`、`docs/`、`.continue/current/CodeZ_v2第一轮优化-plan.md` 与当前源码实现的静态审计，以及 `typecheck/test/build` 验证结果。  
> 目的：记录 Gemini 声称完成但实际未完成、半完成或存在运行时 BUG 的事项，作为后续修复迭代依据。

---

## 0. 总结结论

Gemini 声称 `CodeZ_v2第一轮优化` 已完成，但实际审计结论是：

> 当前实现是一个 **能通过 typecheck/build/test 的半成品 MVP**。代码骨架已经加入，但 `docsv2` 规划中的关键闭环还没有真正完成，尤其是：**权限审批、Patch/Diff/Accept/Reject、验证闭环、ResumeState 防丢失、UI 可观测性、ToolResult 错误语义、MCP/Plugin/SubAgent 等目标架构能力**。

当前最危险的三个问题：

1. **看起来有权限系统，但 UI 未接入时 preload 会自动批准审批请求。**
2. **看起来有 `apply_patch`，但它不是标准 patch，前端 Diff/Reject 也不识别它。**
3. **看起来有事务 txId，但 IPC 参数顺序错位，可能导致 Accept/Reject 失效。**

---

## 1. 实际验证结果

已运行：

- ✅ `npm run typecheck`：通过
- ✅ `npm test`：通过，5 个测试文件，23 个测试通过
- ✅ `npm run build`：通过，有 Vite 动态/静态 import 警告，但不是失败

说明：当前问题不是编译失败，而是**行为层面与架构闭环未完成**。现有测试没有充分覆盖本轮新增核心能力，例如：

- `PermissionManager`
- `ApplyPatchTool`
- 审批 UI
- `AgentRunner` 多轮错误恢复
- `ToolResult` 错误语义
- Diff / Accept / Reject IPC
- ResumeState 自动保存与恢复

额外注意：运行测试后，工作区出现 `.codez-cache/project-snapshots.json` 变更，应判断是否需要纳入忽略或清理。

---

## 2. 计划状态矛盾

`.continue/index.md` 中 iteration-4 被标记为：

- 当前阶段：编译验证
- 状态：✅ 已归档
- 任务数：12
- 完成：12
- 完成率：100%

但 `.continue/current/CodeZ_v2第一轮优化-plan.md` 中仍存在：

- 第三阶段：`🔄 AgentLoop 与 ProviderAdapter 稳定化`
- 第四阶段：`⏳ 上下文压缩及状态防丢失机制`
- 第五阶段：`⏳ 验证闭环及 UI 整合`
- 验收点全部为 `⏳`

结论：**index 被标成完成，但 plan 里的关键验收没有完成。** 后续应修正 `.continue/index.md` 和 plan 状态，避免继续误判。

---

## 3. 当前真实完成度概览

| 模块 | 当前判断 | 说明 |
|---|---:|---|
| `docsv2` 文档整理 | 🟡 基本完成 | `docsv2/00-10` 存在；原 `docs/docsv2` 被删除，属于迁移/移动。 |
| 工具收敛 | 🟡 部分完成 | 新增 `search/read_files/apply_patch`，但行为不完整。 |
| 权限系统 | 🔴 严重未完成 | 有 `PermissionManager`，但 UI 未接入完整，preload 甚至可能自动批准。 |
| Patch / Diff / 回滚 | 🔴 严重未完成 | `apply_patch` 不是文档要求的 patch；Diff UI 没接新工具。 |
| AgentLoop / Provider | 🟡 部分完成 | 有连续失败限制和包装，但 ToolResult 判错有严重漏洞。 |
| 验证闭环 | 🔴 基本未完成 | 只是 prompt 提醒模型跑测试，没有 runtime 自动闭环。 |
| ResumeState / 防丢失 | 🔴 很浅 | 有 `update_resume_state` 工具，但不自动、结构不完整、模型可忘调用。 |
| UI 可观测性 | 🔴 未完成 | 旧编辑 UI 仍识别旧工具名，不识别 `apply_patch`；审批卡片未接。 |
| 测试覆盖 | 🔴 不足 | 新增关键能力几乎没有测试。 |
| MCP Server | ❌ 未实现 | 无 MCP runtime / server 管理 / tool-resource-prompt 接入。 |
| Plugins 插件能力 | ❌ 未实现 | 只有 skills 管理雏形，没有插件系统。 |
| Browser 工具 | ❌ 未实现 | 无浏览器自动化、截图、DOM 验证。 |
| SubAgent / Swarm | ❌ 未实现 | 无子 Agent、Scout、Coder、QA、DAG 调度。 |

---

## 4. 关键 BUG 与未完成事项

### A. 权限审批是假接入：UI 没实现时会自动批准

**现象**：主进程会发送审批请求，但 preload 在前端没有传 `onPermissionRequest` 时会自动 approve。

相关位置：

- `src/main/ipc/chat.handlers.ts`：发送 `CHAT_REQUEST_APPROVAL`
- `src/preload/index.ts`：无 `onPermissionRequest` 时自动调用 approval response 并传 `true`
- `src/renderer/src/components/chat/ChatArea.tsx`：调用 `window.api.chat.stream(...)` 时没有传 `onPermissionRequest`

**影响**：危险操作看似需要 `ask`，实际可能被静默批准，直接违背 `docsv2/04-permission-safety.md`。

**修复要求**：

- preload 没有 UI handler 时必须默认 deny，而不是自动 approve。
- ChatArea 必须接入审批回调，展示用户可见审批卡片。
- 审批结果必须回传 main process，阻塞工具执行直到用户确认。

优先级：P0

---

### B. `run_command` 权限判断参数名写错

**现象**：`RunCommandTool` schema 使用 `commandLine`，但 `PermissionManager` 读取的是 `CommandLine` 或 `command`。

相关位置：

- `src/main/tools/builtin/RunCommandTool.ts`
- `src/main/services/PermissionManager.ts`

**影响**：正常传入 `{ "commandLine": "npm test" }` 时，权限层读不到命令，会把安全命令误判为 `unknown`，从而错误走 `ask`。

**修复要求**：

- 权限判断同时支持 `commandLine` / `CommandLine` / `command`。
- 为 `npm test`、`npm run typecheck`、`npm run build`、`git status` 等补单测。

优先级：P0

---

### C. `apply_patch` 不是文档要求的 Patch 主入口

**现状实现**：当前 `ApplyPatchTool` 参数为：

```ts
filePath
expectedHash
edits
fullOverwrite
newContent
```

**文档要求**：`docsv2/02-edit-diff-rollback.md` 要求：

```ts
type ApplyPatchInput = {
  patch: string
  expectedHashByPath?: Record<string, string>
}

type ApplyPatchOutput = {
  changedFiles: string[]
  diff: string
  summary: string
}
```

**问题**：

1. 当前不是 unified diff / patch 格式。
2. 不支持 `expectedHashByPath`。
3. 返回只是字符串，没有 `changedFiles/diff/summary`。
4. `fullOverwrite` 修改已有文件时可以不传 `expectedHash`，存在覆盖风险。
5. 新建文件时没有进入事务记录，Reject 时不能删除新建文件。

**修复要求**：

- 至少返回结构化结果：`changedFiles`、`diff`、`summary`。
- 修改已有文件必须强制 hash 校验，包括 `fullOverwrite`。
- 新建文件也必须记录事务，以便 Reject 删除。
- 后续再逐步升级为真正 unified diff patch。

优先级：P0/P1

---

### D. Diff / Accept / Reject UI 没接到 `apply_patch`

**现象**：`ToolManager` 已注册新工具 `apply_patch`，但前端编辑审批卡片仍只识别旧工具：

```ts
write_to_file
replace_file_content
multi_replace_file_content
```

相关位置：

- `src/main/tools/ToolManager.ts`
- `src/renderer/src/components/chat/ChatArea.tsx`
- `src/renderer/src/components/chat/ExecutionLogUtils.ts`

**影响**：Agent 用 `apply_patch` 修改文件后，前端可能不会显示编辑审批卡片，也无法正确展示 Diff 或 Reject。

**修复要求**：

- ChatArea 的编辑工具识别逻辑加入 `apply_patch`。
- ExecutionLogUtils 的 edit 类型识别加入 `apply_patch`。
- Diff 展示应优先使用事务服务生成的真实 diff，而不是仅靠工具参数推算。
- preload 暴露 `chat.getDiff`，前端能主动拉取 tx diff。

优先级：P0

---

### E. `txId` IPC 参数顺序错位，可能导致 Accept/Reject 失效

**现象**：main 发送结束事件时参数是：

```ts
streamId, fullContent, stopReason, txId
```

preload 接收签名却是：

```ts
streamId, fullContent, txId
```

**影响**：前端拿到的 `txId` 可能实际是 `stopReason`，真正 txId 丢失。后续 `acceptFile/rejectFile` 找不到真实事务，导致 Accept/Reject 失效。

**修复要求**：

- preload endHandler 签名改为接收 `stopReason` 和 `txId`。
- renderer `onDone` 签名同步调整。
- store 中正确保存 txId。
- 加 IPC 回归测试或手动验证。

优先级：P0

---

### F. ToolResult 封装错误：工具返回 `Error:` 也可能被包装成 `ok: true`

**现象**：`AgentRunner` 只有工具不存在、权限拒绝、catch 异常时设置 `isError = true`。但工具内部常用字符串返回错误，例如：

```ts
return `Error: Hash mismatch! ...`
```

这种情况会被包装成：

```json
{ "ok": true, "data": "Error: Hash mismatch! ..." }
```

**影响**：模型可能以为工具成功，严重影响恢复、自修复和验证闭环。

**修复要求**：

- 短期：AgentRunner 对 `resultMessage` 以 `Error:` / `Error in` 开头的结果标记 `ok:false`。
- 中期：工具 `execute` 返回结构化对象，而不是普通 string。
- `ToolResult.error` 应包含 `code/message/recoverable/suggestion`。

优先级：P0/P1

---

### G. `search` 工具还不稳定，未达到 docsv2 要求

**现状问题**：

- 文件搜索依赖 `git ls-files`。
- 文本搜索优先依赖 `git grep`。
- 非 Git 仓库和未跟踪文件覆盖不足。
- 文件搜索 fallback 基本没有。
- 没有 fuzzy 搜索。
- 返回结构未统一为 `kind/path/line/preview/score/reason`。
- 不支持分页 cursor。

**影响**：`search` 只是早期工具，不能完全替代 Bash `find/grep/rg`。

**修复要求**：

- 增加 filesystem fallback。
- 增加 fuzzy 文件名搜索。
- 统一返回结构：`kind`、`path`、`line`、`preview`、`score`、`reason`。
- 增加分页或 `maxResults + truncated + refine hint`。

优先级：P1

---

### H. `read_files` 只是基础版，预算与行号能力不足

**已有能力**：

- 多文件读取
- `startLine` / `endLine`
- `totalLines`
- `sha256` hash

**缺失能力**：

- `maxTotalLines`
- `maxTotalBytes`
- 每行带行号
- 围绕搜索命中读取上下文
- 预算超限时返回 `omitted` 信息

**修复要求**：

- 增加全局预算限制。
- 输出行号，便于 patch 定位。
- 输出 omitted/truncated 明细。
- 支持根据搜索命中读取上下文窗口。

优先级：P1

---

### I. 验证闭环只是 Prompt，不是 Runtime 闭环

**现状**：`chat.handlers.ts` 会读取 `package.json` scripts，并把验证策略写进 system prompt。

**缺失**：

- 根据 changedFiles 自动推荐最小验证。
- 自动执行验证。
- 结构化 `VerificationResult`。
- 验证失败自动进入修复循环。
- `VerificationLedger`。
- UI 验证面板。

**修复要求**：

- 新增验证策略模块。
- 根据 changedFiles 推荐命令。
- `run_command` 结果结构化。
- 失败输出回传模型并要求修复。
- 最终回复必须包含验证状态。

优先级：P2/P3

---

### J. ResumeState 防丢失机制很弱

**现状**：`ContextManager` 只有简化版：

- `GoalSnapshot`
- `TaskPlan`
- `ResumeState`

**docsv2 要求**：

- `GoalSnapshot`
- `RequirementLedger`
- `DecisionLog`
- `TaskPlan`
- `VerificationLedger`
- `ResumeState`

**问题**：

- `trimMessages` 只裁剪，不会裁剪前自动保存 ResumeState。
- 依赖模型主动调用 `update_resume_state`，模型可能忘记。
- `UpdateResumeStateTool` 的 sessionId 设计存在不一致注释。
- 恢复时只注入简化状态，不足以恢复复杂任务。

**修复要求**：

- 引入完整 Ledger/Log 类型。
- 在裁剪/长任务关键节点自动保存。
- 恢复时强制读取并注入结构化 state。
- UI 显示当前目标、阶段、下一步、待验证项。

优先级：P3

---

### K. UI 文案存在乱码

**现象**：部分用户可见文案乱码，例如：

- 输入框 placeholder
- 文件读取失败提示
- App 注释和部分中文字符串

**影响**：虽然不是 v2 架构核心，但会直接影响实际使用体验。

**修复要求**：

- 修复源码编码问题。
- 检查中文字符串是否 UTF-8 保存。
- 补一次 UI 文案巡检。

优先级：P1/P2

---

## 5. 目标架构节点完成状态

| 架构节点 | 当前状态 | 说明 |
|---|---:|---|
| User → Runtime | ✅ 基础实现 | 用户消息能进入 `chat.handlers.ts`，启动 `AgentRunner`。 |
| Agent Runtime | 🟡 部分实现 | 有基本循环、工具调用、事务、权限检查，但稳定性和错误处理不完整。 |
| Context 上下文构建 | 🟡 部分实现 | 有 `ContextManager`、项目快照、AGENTS.md 注入，但规则系统和 ResumeState 很浅。 |
| Prompt 组装 | 🟡 部分实现 | `chat.handlers.ts` 动态拼 system prompt、工具、skills、环境信息，但不体系化。 |
| Repo 仓库文件/规范 | 🟡 部分实现 | 只自动读根级 `AGENTS.md`，没有完整 `.clinerules` / `.cursorrules` / `.codez/rules` / 目录级规则。 |
| Env 环境与权限 | 🟡 有但有 BUG | 环境信息注入了；权限系统有 `PermissionManager`，但审批 UI 没接好。 |
| Tools 工具 Schema | 🟡 部分实现 | 有 `search`、`read_files`、`apply_patch`、`run_command` 等，但行为不完整。 |
| Skills 索引 | 🟡 部分实现 | 有 `SkillManager` 和 UI/IPC 基础，但不是完整自动 skill runtime。 |
| MCP Server | ❌ 未实现 | 无 MCP runtime、server 管理、tool/resource/prompt 接入。 |
| Plugins 插件能力 | ❌ 未实现 | 当前没有插件系统，只是有 skills 导入/管理雏形。 |
| LLM 执行循环 | 🟡 部分实现 | 能多轮 tool call，但 ToolResult、stop reason、失败恢复仍不稳定。 |
| Plan 任务计划 | ❌ 基本未实现 | 没有内置 `update_plan` / 可见计划状态机。`.continue` 是开发流程文档，不是 App Runtime 计划系统。 |
| SelectSkill 选择 Skill | 🟡 部分实现 | Prompt 中暴露 skills，slash command 有处理迹象，但没有稳定自动选择/强制读取流程。 |
| ReadSkill 读取 SKILL.md | 🟡 靠 Prompt | 系统提示要求模型用 `read_files` 读 skill，但 runtime 不强制。 |
| SelectTool 选择工具 | 🟡 靠模型 | 工具 schema 暴露给模型，但没有 ToolRouter / 推荐策略 / 工具选择约束层。 |
| ToolExec 工具执行层 | 🟡 部分实现 | `ToolManager` + `AgentRunner` 能执行工具，但权限、结构化结果、审计都没闭环。 |
| Shell | 🟡 部分实现 | `RunCommandTool` 存在，但权限参数名有 bug，平台兼容和结构化错误不足。 |
| Patch | 🔴 名义实现，实质不足 | `apply_patch` 不是标准 patch/unified diff，前端 Diff/Reject 也没接到它。 |
| File 文件读写 | 🟡 部分实现 | `read_files`、`apply_patch` 有，但预算、行号、事务、新文件回滚都不完整。 |
| Browser 浏览器 | ❌ 未实现 | 没有浏览器自动化、截图、DOM 检查。 |
| McpTool | ❌ 未实现 | 没有 MCP 工具执行层。 |
| SubAgent | ❌ 未实现 | 没有子 Agent / Swarm / Scout / Coder / QA。 |
| Permission 权限/审批 | 🔴 有严重缺口 | `PermissionManager` 有，但 UI 审批没接完整，preload 没 handler 时会自动批准。 |
| Result 执行结果 | 🟡 部分实现 | AgentRunner 包了 `{ok,data,error}`，但工具返回 `Error:` 字符串时可能仍被当作 `ok:true`。 |
| Verify 测试/构建/验证 | 🔴 基本没实现 | 只是 prompt 提醒模型跑测试，没有 runtime 自动验证闭环。 |
| Final 最终回复 | 🟡 靠模型 | 最终回复是模型自然语言，没有强制包含“已验证/未验证/失败原因/修改文件”。 |

---

## 6. 已完成的骨架能力

Gemini 已经完成或部分完成的骨架如下：

1. 新增 `src/main/services/PermissionManager.ts`
2. 新增 `src/main/tools/builtin/ApplyPatchTool.ts`
3. 新增 `src/main/tools/builtin/SearchTool.ts`
4. 新增 `src/main/tools/builtin/ReadFilesTool.ts`
5. 新增 `src/main/tools/builtin/UpdateResumeStateTool.ts`
6. `ToolManager` 改成注册新工具
7. `AgentRunner` 加了权限检查、连续失败计数、ToolResult 包装
8. Provider 层加了 stopReason 传递
9. `ContextManager` 加了简化 ResumeState 存取
10. `EditTransactionService` 加了 `getDiff`
11. `chat.handlers.ts` 加了审批 IPC、Diff IPC、验证提示 prompt
12. `docsv2` 文档迁移到了根目录

但这些多数仍是骨架或雏形，不能视为稳定完成。

---

## 7. 建议修复顺序

### P0：先修安全和 UI 闭环

1. 修复 `run_command` 权限参数名，支持 `commandLine`。
2. 移除 preload 自动批准逻辑；没有 UI handler 时默认 deny。
3. ChatArea 接入 `onPermissionRequest`，显示审批卡片。
4. 修复 `CHAT_STREAM_END` 参数错位，正确传 `stopReason` 和 `txId`。
5. 前端编辑 UI 识别 `apply_patch`。
6. preload 暴露 `chat.getDiff`。

### P1：修 Patch / Diff / 事务

7. `apply_patch` 返回结构化结果：`changedFiles/diff/summary`。
8. `fullOverwrite` 修改已有文件也必须要求 `expectedHash`。
9. 新建文件也要进入事务，Reject 时能删除。
10. ToolResult 根据工具返回值判断 `Error:`，或工具统一返回结构对象。
11. 修复 UI 乱码。
12. 强化 `search` 和 `read_files` 的预算、fallback、结构化结果。

### P2：补测试

13. `PermissionManager` 单测。
14. `ApplyPatchTool` 单测：hash mismatch、target not found、新建回滚、fullOverwrite 防护。
15. `AgentRunner` 单测：工具失败必须 `ok:false`。
16. IPC 测试：approval request/response、stop、txId。
17. UI 层至少补工具名适配测试或手动验证脚本。

### P3：再做验证闭环和 ResumeState

18. 把验证策略从 prompt 提升成 runtime 模块。
19. ResumeState 自动保存，不依赖模型主动调用。
20. 补 `RequirementLedger` / `DecisionLog` / `VerificationLedger`。
21. UI 展示当前目标、阶段、下一步、待验证项。

### P4：后续目标架构能力

22. MCP runtime / server 管理 / MCP tool/resource/prompt 接入。
23. Plugin 系统。
24. Browser 工具。
25. SubAgent / Scout / Coder / QA / SwarmDispatcher。
26. ToolRouter / 工具选择策略 / 角色工具白名单。
27. 完整 Audit Log / Trace / response chunks 持久化。

---

## 8. 最小稳定闭环目标

在继续扩展 MCP、插件、Browser、SubAgent 前，建议先打通下面这条最小稳定闭环：

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

这条闭环稳定前，不建议继续做 Swarm、多 Agent、MCP、插件市场等高级能力，否则会放大已有问题。

---

## 9. 完成判定标准

后续修复完成后，至少需要满足：

- 危险操作没有 UI 审批时默认拒绝，不允许自动批准。
- `npm test` / `npm run typecheck` 等安全命令能正确 allow。
- `apply_patch` 修改后前端能看到真实 diff。
- Reject 能恢复已有文件，也能删除新建文件。
- hash mismatch 时 ToolResult 必须是 `ok:false`。
- 修改源码后能自动或半自动运行推荐验证命令。
- 验证失败不能最终声称完成。
- ResumeState 在长任务或裁剪前能自动保存并恢复。
- 所有 P0/P1 项至少有单测或明确手动验证记录。
