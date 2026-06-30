# Claude Code 工具对齐改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 CodeZ 内置工具系统向 Claude Code 对齐——新增 11 个工具（Read/Edit/Write/NotebookEdit/Glob/Grep/Bash/PowerShell/AskUserQuestion/PushNotification/Skill），完全替换并删除语义等价的旧 4 工具（read_files/apply_patch/run_command/search），清 PermissionManager 死引用，渲染端工具名接线，验收现有功能无回归。

**Architecture:** 渐进式关门（期一）。工具仍走现有 `Tool` 基类 + `ToolManager` + `AgentRunner` 派发 + `PermissionManager`；新增一个 main 进程内的 `ReadFingerprintStore`（去重）、`BackgroundTaskRegistry`（Bash/PS 后台）、`PushProvider` 接口；渲染端新增 `AskUserQuestionWidget` + 一对 IPC channel。Edit/Write 复用现 `apply_patch` 的事务链路，不动 `EditTransactionService`。

**Tech Stack:** TypeScript + Electron + vitest（node env，`src/tests/**/*.test.ts`）；`@vscode/ripgrep`（新增依赖）。

**参考 spec：** `docs/superpowers/specs/2026-06-30-claude-tool-alignment-design.md`（§3.1 接缝、§3.2 官方描述、§11 验收、§12 回归清单）。

## Global Constraints

- **工具契约**：`extends Tool`；`execute(args: string, ctx: ToolContext): Promise<string>`；`args` 是 **JSON 字符串**，须 `JSON.parse`；返回 **字符串**（错误以 `Error: ...` 开头以便 `isToolErrorResult` 识别，或纯文本）。
- **命名**：与 Claude Code 对齐用 `Read/Edit/Write/NotebookEdit/Glob/Grep/Bash/PowerShell/AskUserQuestion/PushNotification/Skill`（注意首字母大写）。
- **测试**：vitest，`src/tests/*.test.ts`，`environment: node`；每任务先写失败测试再实现；命令 `npm test`（= `vitest run`）。
- **保留不动**：`list_files / get_project_snapshot / fast_context / rollback_last_edit / update_resume_state` 名字、schema、行为。
- **回归兑现**：实现期不得破坏 spec §12 的 12 条（`@file` 预读注入、verification 闭环、resume-state、edit-transaction/rollback、permission ask 闭环、approval IPC、三 provider 映射、双重声明、上下文裁剪、保留 5 工具）。
- **依赖**：仅新增 `@vscode/ripgrep`；不引 notebook 库（手写 .ipynb v4 JSON）；不引 execa。
- **提交**：每任务以独立 commit 提交；正文用 `feat`/`test`/`refactor` 前缀。
- **图片/PDF**：本期不做；Read 命中二进制返 `Cannot read binary file.`。
- **沙箱**：无；Bash/PowerShell 靠 `PermissionManager.getCommandRisk` → allow/ask。

## File Structure

新增（main 进程）：
- `src/main/tools/ReadFingerprintStore.ts` — 会话内已读指纹表
- `src/main/tools/SpawnRunner.ts` — Bash/PowerShell 共用子进程运行器 + `BackgroundTaskRegistry`
- `src/main/tools/builtin/ReadTool.ts` — Read（含去重）
- `src/main/tools/builtin/EditTool.ts` — search-replace，委托事务
- `src/main/tools/builtin/WriteTool.ts` — 整体覆写，委托事务
- `src/main/tools/builtin/GlobTool.ts` — ripgrep --files / fast-glob 回退
- `src/main/tools/builtin/GrepTool.ts` — ripgrep 子进程
- `src/main/tools/builtin/NotebookEditTool.ts` — .ipynb v4 cell 读写
- `src/main/tools/builtin/BashTool.ts`
- `src/main/tools/builtin/PowerShellTool.ts`
- `src/main/tools/builtin/AskUserQuestionTool.ts`
- `src/main/tools/builtin/PushNotificationTool.ts` + `src/main/services/PushProvider.ts`
- `src/main/tools/builtin/SkillTool.ts`（薄；`SkillManager` 加 `getSkillContent`）

修改（main）：
- `src/main/tools/ToolManager.ts` — 注册 11 新工具，移除旧 4 导入
- `src/main/services/PermissionManager.ts` — 清死引用 + 加新映射 + 移除旧名
- `src/main/services/SkillManager.ts` — 加 `getSkillContent`
- `src/main/agent/AgentRunner.ts:375/377/435/40` — verification 名表加 `Edit/Write`、`Bash/PowerShell`；文案与 `buildToolError` 正则更新
- `src/main/ipc/chat.handlers.ts` — 加 `CHAT_REQUEST_ASK_USER` 派发 + AskUser 回调；`<skills_instructions>` 文案 `read_files→Read`
- `src/main/index.ts` — 注册 AskUser IPC 监听 + PushProvider 初始化（如需）
- `package.json` — 加 `@vscode/ripgrep`、`fast-glob`、`@types/fast-glob`

删除（main，完全替换旧工具）：
- `src/main/tools/builtin/ReadFilesTool.ts`（→ Read）
- `src/main/tools/builtin/ApplyPatchTool.ts`（→ Edit/Write）
- `src/main/tools/builtin/RunCommandTool.ts`（→ Bash）
- `src/main/tools/builtin/SearchTool.ts`（→ Grep/Glob）

修改（shared / preload / renderer）：
- `src/shared/ipc/channels.ts` — 加 `CHAT_REQUEST_ASK_USER` / `CHAT_ASK_USER_RESPONSE`
- `src/preload/index.ts` — 加 `chat.respondAskUser` + `onAskUserRequest` 回调
- `src/renderer/src/components/chat/AskUserQuestionWidget.tsx` + `.css`
- `src/renderer/src/components/chat/ChatArea*.tsx` — 接线 AskUserWidget

测试（新增）：
- `src/tests/read-fingerprint-store.test.ts`
- `src/tests/spawn-runner.test.ts`
- `src/tests/read-tool.test.ts`、`edit-tool.test.ts`、`write-tool.test.ts`
- `src/tests/glob-tool.test.ts`、`grep-tool.test.ts`
- `src/tests/notebook-edit-tool.test.ts`
- `src/tests/bash-tool.test.ts`、`powershell-tool.test.ts`
- `src/tests/ask-user-question-tool.test.ts`
- `src/tests/skill-tool.test.ts`
- `src/tests/permission-manager-claude-names.test.ts`（新增映射回归）

---

## 决策注记：alias → 完全替换（偏离 HANDOFF）

用户决议（2026-06-30）：**意义相同的旧工具完全删除，用新的替代**，不走 HANDOLD/File Structure 原写的"alias 委托保留旧类"。原因：现有 `search-read-tools.test.ts`/`apply-patch-tool.test.ts`/`permission-manager.test.ts` 直接断言旧工具输出契约，委托重写会破坏它们并违反 §12 回归精神。因此期一即执行 spec §13 期二的"删除旧名"：

- 删除 `ReadFilesTool/SearchTool/ApplyPatchTool/RunCommandTool` 四个旧类（Task 16）。
- `read_files→Read`、`apply_patch→Edit|Write`、`run_command→Bash`、`search type=text→Grep`/`type=file→Glob` 为**完全替换**，非委托。
- 为保留 Accept/Reject 渲染流，`Edit/Write` 返回与原 `apply_patch` 同形的 JSON `{changedFiles,diff,summary,fileHashAfter}`（Task 3/4），渲染端在 Task 17 扩工具名判定。
- 渲染端 `ExecutionLogUtils/ExecutionLogDetail/editDiffUtils/ChatArea/PermissionApprovalWidget` 的旧名分支在 Task 17 补新名分支。

---

## 任务列表（按序执行）

每个任务一个文件，位于 `docs/superpowers/plans/claude-tool-alignment/`，含完整 TDD 5 步（写失败测试→跑失败→实现→跑通过→commit）。

1. [Task 01 — ReadFingerprintStore](claude-tool-alignment/task-01-read-fingerprint-store.md)
2. [Task 02 — Read 工具](claude-tool-alignment/task-02-read-tool.md)
3. [Task 03 — Edit 工具](claude-tool-alignment/task-03-edit-tool.md)
4. [Task 04 — Write 工具](claude-tool-alignment/task-04-write-tool.md)
5. [Task 05 — Glob 工具](claude-tool-alignment/task-05-glob-tool.md)
6. [Task 06 — Grep 工具](claude-tool-alignment/task-06-grep-tool.md)
7. [Task 07 — NotebookEdit + Read .ipynb 特化](claude-tool-alignment/task-07-notebook-edit-tool.md)
8. [Task 08 — SpawnRunner + BackgroundTaskRegistry](claude-tool-alignment/task-08-spawn-runner.md)
9. [Task 09 — Bash 工具](claude-tool-alignment/task-09-bash-tool.md)
10. [Task 10 — PowerShell 工具](claude-tool-alignment/task-10-powershell-tool.md)
11. [Task 11 — PushProvider + DesktopNotificationProvider](claude-tool-alignment/task-11-push-provider.md)
12. [Task 12 — PushNotification 工具](claude-tool-alignment/task-12-push-notification-tool.md)
13. [Task 13 — Skill 工具](claude-tool-alignment/task-13-skill-tool.md)
14. [Task 14 — AskUserQuestion（IPC+preload+Widget+工具+拦截）](claude-tool-alignment/task-14-askuserquestion-ipc-tool-widget.md)
15. [Task 15 — PermissionManager 清理 + 新映射](claude-tool-alignment/task-15-permission-manager-cleanup.md)
16. [Task 16 — 注册新工具 + 删除旧 4 工具 + 收口引用](claude-tool-alignment/task-16-register-delete-old-tools.md)
17. [Task 17 — 渲染端工具名接线](claude-tool-alignment/task-17-renderer-tool-name-wiring.md)
18. [Task 18 — 回归 + 最终验收](claude-tool-alignment/task-18-regression-and-final-acceptance.md)