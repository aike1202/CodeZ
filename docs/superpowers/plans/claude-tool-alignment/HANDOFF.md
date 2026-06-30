# Claude Code 工具对齐改造 — 实现交接（HANDOFF）

> 用于"换会话继续"。读完这一份就能直接续写剩余 Task，不必重新探索。

## 状态

- ✅ spec 已写、已扩展、已提交：`docs/superpowers/specs/2026-06-30-claude-tool-alignment-design.md`
  - commit `299de39`（初版）、`afc84a9`（自含化：接缝 file:line + 预算 + IPC + 验收 + 回归清单）、`aa15b21`（§3.2 Claude 官方工具描述 + 本项目适配）
- ✅ plan 容器已建：`docs/superpowers/plans/claude-tool-alignment/`（一个任务一个文件）
- ✅ 主 plan 索引已起头：`docs/superpowers/plans/2026-06-30-claude-tool-alignment.md`（含 Goal/Architecture/Tech Stack/Global Constraints/File Structure；任务正文未落盘）
- ⚠️ **剩余工作：写 Task 1 → Task 13 共 14 个任务文件**（一个任务一个 `.md`，放到 `claude-tool-alignment/` 目录）

## 续写规则（务必遵守）

1. **一个任务一个文件**：`claude-tool-alignment/task-NN-<slug>.md`。每文件内含该任务完整 TDD 5 步（写失败测试→跑失败→实现→跑通过→commit）。
2. **粒度**：每步含可用代码（关键易错处完整给；重复套路如 ripgrep 子进程调用只决一次）。
3. **工具契约**：`extends Tool`；`execute(args: string, ctx: ToolContext): Promise<string>`；`args` 是 JSON 字符串须 `JSON.parse`；错误以 `Error: ...` 开头便于 `isToolErrorResult` 识别。
4. **测试**：vitest，`src/tests/*.test.ts`，`environment: node`；`npm test` = `vitest run`；先 RED 再 GREEN。
5. **回归**：不得破坏 spec §12 的 12 条（`@file` 预读注入、verification 闭环、resume-state、edit-transaction/rollback、permission ask、approval IPC、三 provider 映射、双重声明、上下文裁剪、保留 5 工具）。
6. **保留不动**：`list_files / get_project_snapshot / fast_context / rollback_last_edit / update_resume_state`。
7. **依赖**：仅新增 `@vscode/ripgrep`；手写 .ipynb v4 JSON（无 notebook 库）；不引 execa。
8. **沙箱/图片/PDF**：本期不做。

## 全部任务清单（按此顺序写）

> 来源：spec §3、§4-§6。每个任务**对应一行 spec 验收标准**（§11）。

| # | 文件名 | 工具/主题 | spec 锚 | 关键依赖 |
|---|--------|-----------|---------|----------|
| 01 | `task-01-read-fingerprint-store.md` | `ReadFingerprintStore`（去重指纹表单例） | §4.1 | — |
| 02 | `task-02-read-tool.md` | `Read`（含 Wasted-call 去重 + 二进制/2000行/cat-n） | §4.1 §3.2 Read | Task01；`ReadFingerprintStore` 需加 `isUnchangedKnown` |
| 03 | `task-03-edit-tool.md` | `Edit`（search-replace，须先 Read，唯一/replace_all，复用事务） | §4.2 §3.2 Edit | Task01/02；`EditTransactionService.backupFile/getDiff` |
| 04 | `task-04-write-tool.md` | `Write`（整体覆写，须先 Read 才能覆盖，新建可直接写） | §4.3 §3.2 Write | Task01/02；事务 |
| 05 | `task-05-glob-tool.md` | `Glob`（`@vscode/ripgrep --files` + glob 过滤，回退 `fast-glob`，按 mtime 排序） | §4.4 §3.2 Glob | `@vscode/ripgrep`、`fast-glob`（已有则不再加） |
| 06 | `task-06-grep-tool.md` | `Grep`（ripgrep 子进程；`output_mode files_with_matches/content/count`；`-A/-B/-C/-n/-i/-o/glob/type/multiline/head_limit/offset`） | §4.5 §3.2 Grep | `@vscode/ripgrep` |
| 07 | `task-07-notebook-edit-tool.md` | `NotebookEdit`（零依赖 .ipynb v4 cell replace/insert/delete；`<cell id>` 读出） | §4.6 §3.2 NotebookEdit | Read 对 `.ipynb` 特化需在 Task02 兼容或在此任务补 Read 特化 |
| 08 | `task-08-spawn-runner.md` | `SpawnRunner` + `BackgroundTaskRegistry`（Bash/PS 共用：timeout/run_in_background/PID/stdout 文件/head+tail 截断） | §5.1 §5.2 §5.3 | `child_process.spawn` |
| 09 | `task-09-bash-tool.md` | `Bash`（Git Bash 优先→`spawn bash` 回退；前/background；timeout；工作目录会话持久） | §5.1 §3.2 Bash | Task08 |
| 10 | `task-10-powershell-tool.md` | `PowerShell`（`powershell.exe -NoProfile -NonInteractive -Command`；5.1 限制写 description） | §5.2 §3.2 PowerShell | Task08 |
| 11 | `task-11-push-provider.md` | `PushProvider` 接口 + `DesktopNotificationProvider`（Electron Notification + 点击 focus） | §6.2 §3.2 PushNotification | Electron `Notification` |
| 12 | `task-12-push-notification-tool.md` | `PushNotification` 工具（<200 字、status、`{sent}` 回灌） | §6.2 | Task11 |
| 13 | `task-13-skill-tool.md` | `Skill` 工具（`SkillManager.getSkillContent(name)` 取正文；未命中列清单；AgentRunner allow 不二次 ask） | §6.3 §3.2 Skill | `SkillManager` 加 `getSkillContent` |
| 14 | `task-14-askuserquestion-ipc-tool-widget.md` | AskUserQuestion：IPC channel `CHAT_REQUEST_ASK_USER`/`...RESPONSE:<id>` + preload `respondAskUser`/`onAskUserRequest` + 渲染端 `AskUserQuestionWidget` + 工具 | §6.1 §3.2 AskUserQuestion §8.1 | 照抄 `CHAT_REQUEST_APPROVAL` 范式（spec §3.1 末段 + preload 现有 approvalHandler） |
| 15 | `task-15-permission-manager-cleanup.md` | `PermissionManager`：清死引用 `write_to_file/replace_file_content/multi_replace_file_content`；加 `Read/NotebookEdit/Glob/Grep/Skill/PushNotification→allow`、`Edit/Write→apply_patch 同策略`、`AskUserQuestion→ask`、`Bash/PowerShell→复用 getCommandRisk` | §5.4 §3.1 PermissionManager | — |
| 16 | `task-16-register-tools-and-aliases.md` | `ToolManager.registerBuiltinTools` 注册新 14 工具 + 旧名 alias（`read_files→Read`、`apply_patch→Edit|Write`、`run_command→Bash`、`search type=text→Grep`、`search type=file→Glob`）；`AgentRunner.ts:375-377` verification 名表加 `Edit/Write`；`chat.handlers.ts` `<available_tools>` 同步 | §7 §3.1 接缝 | 全部前置 Task |
| 17 | `task-17-regression-and-final-acceptance.md` | 跑 spec §12 回归 + §11 验收；手动验 `@file` 不再 cat fallback、AskUser 流程、PS 在 Windows、后台跨轮 | §11 §12 §13 | 全部 |

> 编号到 17 是因为拆得细；合并执行时按需并。**任务编号是文件名前缀，不是 commit 数量**。

## 关键接缝（已核验 file:line，从 spec §3.1 抄）

- `src/main/tools/Tool.ts:3/17/19/21/29` — 工具基类。
- `src/main/tools/ToolManager.ts:14(Map)/20(register)/22-30(9 实例)/47(getToolDefinitions)` — 注册与声明。
- `src/main/agent/AgentRunner.ts:75/261/295/310-328/350-367/375-377(verification 名表)/421-442(verification 拦截)` — 派发循环。
- 三 provider 映射：Gemini `:100-106` functionDeclarations、Anthropic `:51-55` input_schema、OpenAI `:95` 原样。
- `chat.handlers.ts:113-118(<available_tools>)`、`:126-132(<skills_instructions>)`、`:172-180(approval IPC 范式)`。
- `PermissionManager.ts:46-81(checkToolPermission)`、`:83-105(createPermissionRequest)`；死引用在 `:56` 与 `:91`。
- `ReadFilesTool.ts:80-82(预算 40000/1200/120000)`、`:199-201(行号前缀 N\\t)`、512字节二进制检测、5MB 上限。
- `ApplyPatchTool.ts:65-160(execute + expectedHash + 事务)` — Edit/Write 复刻其事务与校验链路。
- `SkillManager.ts:59(scanDir)/69-94(frontmatter 解析)/153(getSkills)/缓存:149`；`SkillDefinition{ id,name,description,triggers?,content,path?,enabled?,isGlobal? }`（`src/shared/types/skill.ts`，已含 `content`，SkillTool 直接用 `getSkills` 找命中项取 `.content`，无需新 API；spec §3.2 末段提到"加 getSkillContent"是别名糖，可不做）。
- IPC 范式（AskUser 照抄）：preload `index.ts:75-170` 中 `approvalHandler`/`cleanup`/`respondToApproval`。

## 已核验的环境约定

- vitest 1.6，node env，`src/tests/**/*.test.ts`；`npm test` = `vitest run`；`npm run typecheck` = `tsc --noEmit`。
- 测试模式（沿用 `apply-patch-tool.test.ts`）：`MemoryEditTransactionService implements Pick<EditTransactionService,'backupFile'|'getDiff'>`；临时工作区 `os.tmpdir()`。
- 工具测试断言风格：`expect(result).toContain('Error: ...')`、`expect(await fs.readFile(fp,'utf-8')).toBe(...)`。

## 续写第一步

打开新会话后，让 agent：
1. 读本 HANDOFF 与 spec `docs/superpowers/specs/2026-06-30-claude-tool-alignment-design.md`。
2. 调用 `writing-plans` skill（已在进行中）。
3. 按"全部任务清单"逐文件写 task-NN-*.md 到 `docs/superpowers/plans/claude-tool-alignment/`；每写一个用 `Write` 工具（一个文件一次性写完）。
4. 全部写完后回填 `2026-06-30-claude-tool-alignment.md` 主索引的"任务列表"段链接到各 task-NN 文件，并提交。
5. 做 writing-plans 的自检（spec 覆盖/占位符/类型一致性）。
6. 给执行选项（subagent-driven / inline）。

## 已起草但**未落盘**的 Task 1-3 完整代码

> 上游会话已完整写过 Task 1-3 的 TDD 5 步代码，因 heredoc/Write 卡顿没成功追加。**新会话直接照下面"基线代码"挂到对应 task 文件即可**——避免重新发明。

### Task 1 基线代码

`src/main/tools/ReadFingerprintStore.ts`：
单例；私有 `Map<sessionId, Map<absPath, sha256>>`；方法 `record(sessionId,absPath,sha256)`、`isUnchanged(sessionId,absPath,sha256):boolean`、`isUnchangedKnown(sessionId,absPath):boolean`（仅查路径，Task 3 需要）、`clear(sessionId)`。见 spec Task 1 测试 5 例。

### Task 2 基线代码（ReadTool）

- `get name()='Read'`、`parameters_schema={file_path(req,绝对),limit?,offset?}`。
- execute：resolve 绝对路径 + workspace 前缀校验（大小写不敏感、`\\`→`/`）→ `fs.readFile` buffer → 首 512 字节含 NUL → `Cannot read binary file.` → >5MB → 错；算 sha256 → `ReadFingerprintStore.isUnchanged(sessionId, normalizedTarget, sha)` → 命中返 `Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.` → 否则按 offset/limit 切行输出 `N\\t<line>` → `store.record`。
- Task 2 测试 6 例见上轮草稿（首次/同 sha Wasted/改后返回/二进制/越界/缺参）。

### Task 3 基线代码（EditTool）

- schema `{file_path(req),old_string(req),new_string(req),replace_all?}`。
- execute：resolve+越界校验 → `store.isUnchangedKnown(sessionId, normalizedTarget)` 否 → `Error: You must Read this file in this conversation before editing it.` → 读文件 → `\\r\\n` 规范化 → 计数 `split(target).length-1`：0 → not found；>1 且非 replace_all → not unique → 替换 → `editTransactionService.backupFile(txId,abs)` → 写盘 → 算新 sha → `store.record` → 返 `Edited <abs>. New sha256: <h>`。
- Task 3 测试 6 例见上轮草稿。
- **依赖 Task 1 加 `isUnchangedKnown`**。

## 不要做

- 不要重新探索代码（接缝在 spec §3.1 已固化）。
- 不要改 `list_files/get_project_snapshot/fast_context/rollback_last_edit/update_resume_state`。
- 不要本期做图片/PDF/沙箱/Task*/计划模式/Worktree/Monitor/WebFetch/DesignSync。
- 不要引 notebook 库 / execa。