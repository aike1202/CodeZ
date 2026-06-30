# Claude Code 工具对齐改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 CodeZ 内置工具系统向 Claude Code 对齐——新增 11 个工具（Read/Edit/Write/NotebookEdit/Glob/Grep/Bash/PowerShell/AskUserQuestion/PushNotification/Skill），旧 5 名 alias 委托，清 PermissionManager 死引用，验收现有功能无回归。

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
- `src/main/tools/ToolManager.ts` — 注册新工具 + alias
- `src/main/tools/builtin/ReadFilesTool.ts` — alias 委托 Read + 持久 `ReadFingerprintStore`
- `src/main/tools/builtin/ApplyPatchTool.ts` — 内部委托 Edit/Write（alias 期保留 `apply_patch` 名）
- `src/main/tools/builtin/RunCommandTool.ts` — alias 委托 Bash
- `src/main/tools/builtin/SearchTool.ts` — `type:text|file` 委托 Grep/Glob
- `src/main/services/PermissionManager.ts` — 清死引用 + 加新映射
- `src/main/services/SkillManager.ts` — 加 `getSkillContent`
- `src/main/agent/AgentRunner.ts:375-377` — verification 名表加 `Edit/Write`
- `src/main/ipc/chat.handlers.ts` — 加 `CHAT_REQUEST_ASK_USER` 派发 + AskUser 回调
- `src/main/index.ts` — 注册 AskUser IPC 监听 + PushProvider 初始化
- `package.json` — 加 `@vscode/ripgrep`

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