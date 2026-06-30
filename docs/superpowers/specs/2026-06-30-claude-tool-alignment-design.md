# Claude Code 工具对齐改造设计

- 日期：2026-06-30
- 来源：`ClaudeCodelogs/v101.txt`（Claude Code cc_version=2.1.196.364）声明的 33 工具
- 范围：把 CodeZ 的内置工具系统向 Claude Code 对齐——**文件操作全部实现、Shell/命令执行实现、用户交互实现**；子代理与编排、任务管理(Todo)、计划模式、Worktree(Git 隔离)、监控与调度、网络、设计系统同步等**本期留空**（不在范围内）。
- 策略：**渐进式关门**（方案 A）。本期=对齐+alias；下周期=收口删旧名。

---

## 1. 背景与现状

现有工具（`src/main/tools/`）契约与机制（基于代码探索结论）：

- **工具基类**：`Tool.ts`，契约 `name / description / parameters_schema / execute(args:string, ctx:ToolContext):Promise<string>`。`args` 是 JSON 字符串，`return` 是字符串。
- **注册**：`ToolManager.registerBuiltinTools()` 硬编码 9 个工具实例；`Map<string,Tool>` 按 `name` 查；`getToolDefinitions()` 转 OpenAI 形 `ToolDefinition[]`，各 provider 再各自映射（Gemini→functionDeclarations / Anthropic→input_schema / OpenAI 原样）。
- **声明双重化**：除原生 `function` 声明外，`chat.handlers.ts` 还把工具以文本 `<available_tools>` 列在 system prompt。
- **派发**：全在 `AgentRunner.run` 一个文件里——流式累积 `toolCallsChunk`、`toolManager.getTool(name)`、`PermissionManager.checkToolPermission` 决定 allow/ask/deny、`execute()`、结果包成 `{ok,data|error}` 作为 `role:"tool"` 消息回灌。
- **现有 9 工具**：`list_files / read_files / search / get_project_snapshot / rollback_last_edit / update_resume_state / apply_patch / run_command / fast_context`。
- **没对应物但保留**：`list_files / get_project_snapshot / fast_context / rollback_last_edit / update_resume_state`——项目独有能力（快照/回滚/恢复/事务），**本期不动**。
- **缺失能力**：无图片/PDF；无"已读去重"；`apply_patch` 同时承载 search-replace+fullOverwrite；无独立 Grep/Glob（被 `search` 合并）；Shell 只有 `run_command`（`exec`、无 background、无沙箱、无流式）；无 PowerShell；无 NotebookEdit；无 AskUserQuestion；无 PushNotification；Skill 仅以 prompt 文本提示模型去 `read_files`，并非工具。

我们之前分析 Claude Code 处理 `@file` 时发现：`@file` 被预读入上下文、Read 触发"未变即拦截"。本设计把这套反直觉但省 token 的去重逻辑引入 Read。

---

## 2. 目标与非目标

### 目标

1. 内置工具命名契约向 Claude Code 对齐：`Read / Edit / Write / NotebookEdit / Glob / Grep / Bash / PowerShell / AskUserQuestion / PushNotification / Skill` 共 **11 个新工具**。
2. 文件操作全能力：Read 加哈希去重；Edit/Write 拆 `apply_patch` 且共用事务；Glob/Grep 走 ripgrep；NotebookEdit 完整 cell 读写。
3. Shell 双引擎：Bash（Git Bash 优先、回退 child_process）+ PowerShell（`powershell.exe -NoProfile -NonInteractive`）；都支持 background/timeout/流式/截断。
4. 用户交互：AskUserQuestion 真工具 + 渲染端多选弹窗；PushNotification 桌面 toast + 预留 PushProvider；Skill 真工具 + 保留现有 prompt 提示路径。
5. 旧名 alias 委托，避免一期破坏 AgentRunner verification-loop / resume-state / edit-transaction / PermissionManager 死引用。
6. 收掉 `PermissionManager` 现有死引用（`write_to_file / replace_file_content / multi_replace_file_content` 等）。

### 非目标（本期留空，用户明确）

- 子代理与编排（`Agent / SendMessage / Workflow / ReportFindings`）
- 任务管理 Todo（`TaskCreate/Get/List/Update/Output/Stop`）
- 计划模式（`EnterPlanMode / ExitPlanMode`）
- Worktree Git 隔离（`EnterWorktree / ExitWorktree`）
- 监控与调度（`Monitor / ScheduleWakeup / CronCreate/Delete/List`）
- 网络（`WebFetch / WebSearch`）
- 设计系统同步（`DesignSync`）
- Read 的图片 base64 内联 / PDF 文本抽取——本期**不上**（你已明确）。
- Shell 沙箱——维持现状无沙箱，靠 PermissionManager 风险评估与 ask。

---

## 3. 工具清单与对应关系

| 新工具 | 对应 Claude | 复用/替换 | 状态 |
|--------|-------------|-----------|------|
| `Read` | Read | 替换 `read_files`（alias 期） | 改造+加去重 |
| `Edit` | Edit | 拆 `apply_patch` 的 `edits[]` 模式 | 新（壳）共用事务逻辑 |
| `Write` | Write | 拆 `apply_patch` 的 `fullOverwrite` | 新（壳）共用事务逻辑 |
| `NotebookEdit` | NotebookEdit | 新能力 | 新 |
| `Glob` | Glob | 替 `list_files` 文件检索子集（list_files 整体保留） | 新 |
| `Grep` | Grep | 替 `search` 的 `type:"text"`（search 保留） | 新（ripgrep） |
| `Bash` | Bash | 替 `run_command`（alias 期） | 改造+加 background/流式 |
| `PowerShell` | PowerShell | 新 | 新 |
| `AskUserQuestion` | AskUserQuestion | 新 | 新 |
| `PushNotification` | PushNotification | 新 | 新 |
| `Skill` | Skill | 现有 prompt 提示路径保留；新增工具 | 新 |

**保留不动**：`list_files / get_project_snapshot / fast_context / rollback_last_edit / update_resume_state`。

**alias**：`read_files` / `apply_patch` / `run_command` / `search(text)` 在本期以同文件薄包装形式委托给对应新工具（`read_files→Read`、`apply_patch→Edit|Write`、`run_command→Bash`、`search type=text→Grep`、`search type=file→Glob`），下周期一次性删除。

### 3.1 现有系统契约与接缝（file:line，实现期不再依赖对话上下文）

本小节把改造所依赖的现有代码事实**固化为 spec 的一部分**。改这些文件前必须对位到下述行号；若行号因前期改动漂移，按符号名重新定位。

- **工具基类契约** — `src/main/tools/Tool.ts`：
  - `ToolContext` 接口 `:3`：`{ workspaceRoot, sessionId, resumeStateKey, transactionId, editTransactionService }`。
  - 抽象契约 `:17/:19/:21/:29`：`get name()`、`get description()`、`get parameters_schema(): Record<string,any>`、`execute(args: string, context: ToolContext): Promise<string>`。
  - **关键**：`execute` 收到的 `args` 是 **JSON 字符串**（不是对象），返回值也是 **字符串**。所有新工具必须 `JSON.parse(args)` 入参、`stringify`/纯文本出参。
- **注册与声明** — `src/main/tools/ToolManager.ts`：
  - `tools: Map<string, Tool>` `:14`，按 `tool.name` 查。
  - `registerBuiltinTools()` `:20`：硬编码 9 个实例 `:22-30`（`ListFilesTool/ReadFilesTool/SearchTool/GetProjectSnapshotTool/RollbackLastEditTool/UpdateResumeStateTool/ApplyPatchTool/RunCommandTool/FastContextTool`）。**新增工具在此追加**，alias 在其后注册（同 Map，旧名 key 委托新实现）。
  - `getTool(name)` `:38`；`getAllTools()` `:42`；`getToolDefinitions()` `:47`：`map(t => ({ type:'function', function:{ name, description, parameters } }))` ——这是**唯一**对外声明源（OpenAI 形 `ToolDefinition`）。
- **派发循环** — `src/main/agent/AgentRunner.ts`：
  - `availableTools` `:75`：`config.tools || this.toolManager.getToolDefinitions()`。
  - 工具并发执行 `Promise.all` `:261`；`toolManager.getTool(name)` `:295`；未知工具回错 `:298-300`。
  - 权限闸 `:310-328`：`PermissionManager.checkToolPermission` + `'ask'` 时 `await callbacks.onPermissionRequest(permReq)`；用户拒 → `Error: User denied permission for this operation.` `:321`。
  - 结果包裹 `:350-358` `{ok:true,data}` / `{ok:false,error}` 并作为 `role:'tool'` `:360-367` 回灌。
  - **verification 闭环硬编码工具名** `:375-377`：`['apply_patch','write_to_file','replace_file_content','multi_replace_file_content']` → `filesModifiedInSession=true`；`:377` `run_command` 记验证结果。**本期加入 `Edit`、`Write` 到此列表**；alias 期保留 `apply_patch`/`run_command` 名以保证闭环文案 `:435` 生效。
  - **verification 拦截** `:421-442`：文件被改但最后验证命令失败时注入"必须修复"提示；其文案 `:435` 提到 `read_files, apply_patch, run_command`——alias 期内仍是有效名，不改文案。
- **三 provider 各自映射** — `src/main/services/chat/`：
  - **Gemini** `GeminiProvider.ts :100-106`：`[{ functionDeclarations: tools.map(t => ({ name, description, parameters: t.function.parameters })) }]`。
  - **Anthropic** `AnthropicProvider.ts :51-55`：`[{ name, description, input_schema: t.function.parameters }]`。
  - **OpenAI** `OpenAIProvider.ts :95`：`tools` 原样透传。
  - 结论：新工具只需保证 `description` + `parameters_schema`(JSON Schema) 正确，三 provider 自动翻译；勿在 provider 内做工具特例。
- **system prompt 双重声明** — `src/main/ipc/chat.handlers.ts`：
  - `<available_tools>` `:113-118`：把 `getToolDefinitions()` 以文本 `name: description` 列入 prompt。**新增工具同步出现于此**；alias 期旧名保留占位。
  - `<skills_instructions>` `:126-132`：激活的 skill 提示模型去 `read_files` SKILL.md。**本期不删**（Skill 工具并立）。
- **上下文裁剪** — `src/main/agent/ContextManager.ts`：`truncateToolOutput :166` 对大输出动态截断（约 15k–60k 字符预算）。Read/Grep/Glob 大输出走此路径，设计时使返回体可被安全截断。
- **ReadFilesTool 现有预算与检测** — `src/main/tools/builtin/ReadFilesTool.ts`（Read 必须继承，勿回归）：
  - 默认常量 `:80-82`：`maxCharsPerFile=40000`、`maxTotalLines=1200`、`maxTotalBytes=120000`；`includeLineNumbers !== false` `:83`。
  - 行号前缀 `:199-201`：`"${startLine + index}\t${line}"` —— `Edit` 匹配时须剥此前缀。
  - 二进制检测：首 512 字节含 NUL 即判二进制 → `Cannot read binary file.`。
  - 5MB 上限。
  - 工作区前缀校验（大小写不敏感，Windows-aware）`:152-155`。
  - 返回 `fileHash`(SHA256)，现仅供 `apply_patch` 的 `expectedHash` 校验**用**；本期复用此 hash 作为去重指纹。
- **apply_patch + 事务链路** — `src/main/tools/builtin/ApplyPatchTool.ts` + `EditTransactionService`：
  - `edits[]:{targetContent,replacementContent}` 为 search-replace；`fullOverwrite + newContent` 为整体覆写；`expectedHash` 强校验已存在文件防覆写陈旧。
  - Edit/Write **复刻**这两条路径，写入走同一个 `EditTransactionService`，`rollback_last_edit` 自然覆盖新工具（事务是按 `transactionId` 维度，与工具名无关）。
- **PermissionManager 现有引用** — `src/main/services/PermissionManager.ts`：
  - 只读白名单 `:47`：`['search','list_files','read_files','get_project_snapshot','fast_context']` → `allow`。
  - 写工具列表 `:56`：`['apply_patch','write_to_file','replace_file_content','multi_replace_file_content']` —— **`write_to_file/replace_file_content/multi_replace_file_content` 为死引用**（无对应工具类）。
  - `run_command` 风险评估 `:73-77`：`safe→allow`、`destructive→ask`、其余 `ask`。
  - `createPermissionRequest` `:83` + args diff 计算 `:91` 也以 `write_to_file/replace_file_content/apply_patch` 为分支。
  - **本期收口**：写工具列表改为 `['apply_patch','Edit','Write']`（alias 期保留 `apply_patch`）；删除 `write_to_file/replace_file_content/multi_replace_file_content` 三处死引用；新增 `AskUserQuestion`→`ask`、`Read/NotebookEdit/Glob/Grep/Skill/PushNotification`→`allow`。
- **SkillManager 扫描 mechanics** — `src/main/services/SkillManager.ts`：
  - `scanDir(dir, config, isGlobal)` `:59`；只收 `SKILL.md` 或 `*.skill.md` `:69`。
  - frontmatter 解析 `:76-82`：`name:`、`description:`、`triggers: [a,b,c]`。
  - id 构建 `:87`：global→`global-<parentDirName>`，workspace→`workspace-<fileName>`。
  - 扫描目录：全局 `getGlobalSkillsDir()`（`~/.codez/skills`）`:137`；工作区 `<workspace>/.skills` `:142-144`。
  - `getSkills(workspaceRoot)` `:153`（带 cache `:149`）。**SkillTool.execute 复用此 API** 取正文。
- **IPC 审批范式**（AskUserQuestion 照抄）— `src/main/ipc/chat.handlers.ts :172-180`：
  - main→renderer：`sender.send(CHAT_REQUEST_APPROVAL, streamId, request)`。
  - renderer→main：`ipcMain.handleOnce(CHAT_APPROVAL_RESPONSE:<request.id>, ...)` 解析用户布尔。
  - preload 转发 `CHAT_REQUEST_APPROVAL → callbacks.onPermissionRequest`；无 handler 时自动拒（`respondToApproval(id,false)`）。
  - AskUserQuestion 复刻为 `CHAT_REQUEST_ASK_USER` + `CHAT_ASK_USER_RESPONSE:<requestId>`，payload 携带 `questions[]`，回 `answers`。

---

### 3.2 Claude Code 官方工具描述（权威参考 + 本项目适配）

下述引文逐字摘自 Claude Code（cc_version=2.1.196.364）通过 API 声明的 `functionDeclarations[].description`（来源 `ClaudeCodelogs/v101.txt`）。本项目实现这 11 个工具时，`get description()` **必须把这些语义放进 description**；与本项目不一致处用「本项目适配」标注收窄/替换。

---

#### Read（官方）
> Reads a file from the local filesystem.
> - `file_path` must be an absolute path.
> - Reads up to 2000 lines by default.
> - When you already know which part of the file you need, only read that part.
> - Results returned using cat -n format, line numbers starting at 1.
> - Reads images (PNG, JPG, …) and presents them visually. Reads PDFs via the `pages` parameter (max 20 pages/request; required for PDFs over 10 pages). Reads Jupyter notebooks (.ipynb) as cells with outputs.
> - Reading a directory, a missing file, or an empty file returns an error or system reminder rather than content.
> - Do NOT re-read a file you just edited to verify — Edit/Write would have errored if the change failed, and the harness tracks file state for you.

**本项目适配**：默认行数用现 `ReadFilesTool` 预算 `maxTotalLines=1200 / maxTotalBytes=120000`，不照搬"2000 lines"常量；图片/PDF **本期不实现**，命中二进制返 `Cannot read binary file.`；新增哈希去重（`Wasted call —…`）须在 description 体现"不要重读未变文件"；`.ipynb` 按 §4.6 渲染为 `<cell id>` 文本。

---

#### Edit（官方）
> Performs exact string replacement in a file.
> - You must Read the file in this conversation before editing, or the call will fail.
> - `old_string` must match the file exactly, including indentation, and be unique — the edit fails otherwise. Strip the Read line prefix (line number + tab) before matching.
> - `replace_all: true` replaces every occurrence instead.

**本项目适配**：与现 `apply_patch` 的 `edits[]` 单点等价；复用 `EditTransactionService` 与 `expectedHash` 防覆写陈旧；唯一性校验、剥 `数字\t` 前缀沿用官方语义。

---

#### Write（官方）
> Writes a file to the local filesystem, overwriting if one exists.
> When to use: creating a new file, or fully replacing one you've already Read. Overwriting an existing file you haven't Read will fail. For partial changes, use Edit instead.

**本项目适配**：等价 `apply_patch` 的 `fullOverwrite+newContent`；新建可直接写，覆盖须本会话先 Read；走事务可回滚；workspace 外拒绝。

---

#### NotebookEdit（官方）
> Replaces, inserts, or deletes a single cell in a Jupyter notebook (.ipynb file).
> - You must use the Read tool on the notebook in this conversation before editing — this tool will fail otherwise.
> - `notebook_path` must be an absolute path.
> - `cell_id` is the `id` attribute shown in the Read tool's `<cell id="...">` output. It is required for `replace` and `delete`.
> - `edit_mode` defaults to `replace`. Use `insert` to add a new cell after the given `cell_id` (or at the beginning if omitted) — `cell_type` is required when inserting. Use `delete` to remove the cell.

**本项目适配**：零依赖手写 notebook v4 JSON 读写（无第三方 notebook 库）；Read 对 `.ipynb` 须输出 `<cell id="...">` 文本以供取 id。

---

#### Glob（官方）
> Fast file pattern matching. Supports glob patterns like `"**/*.js"` or `"src/**/*.ts"`. Returns matching file paths sorted by modification time.

**本项目适配**：引擎用 `@vscode/ripgrep --files`（含 `--glob`），回退 `fast-glob`；`list_files` 仍保留供既有引用（不删）。

---

#### Grep（官方）
> Content search built on ripgrep. Prefer this over `grep`/`rg` via Bash — results integrate with the permission UI and file links.
> - Full regex syntax (e.g. "log.*Error", "function\s+\w+"). Ripgrep, not grep — escape literal braces (`interface\{\}`).
> - Filter with `glob` (e.g. `**/*.tsx`) or `type` (e.g. js, py, rust).
> - `output_mode`: "content" (matching lines), "files_with_matches" (paths only, default), or "count".
> - `multiline: true` for patterns that span lines.

**本项目适配**：引擎 `@vscode/ripgrep` 子进程；ripgrep 不可用时返错（不回退纯 JS）；参数补齐 v101 中的 `-A/-B/-C/-n/-i/-o/context/head_limit/offset`；`search` type=text 经 alias 委托给 Grep。

---

#### Bash（官方）
> Executes a bash command and returns its output.
> This tool runs Git Bash (POSIX sh), not cmd.exe or PowerShell. Use Unix shell syntax: `/dev/null` not `NUL`, forward slashes, `$VAR` not `%VAR%`. Do not use PowerShell here-strings or backtick continuation — for multi-line strings use a heredoc.
> - Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt.
> - Avoid using this tool to run `find`, `grep`, `cat`, etc. — use dedicated tools instead.
> - `timeout` in ms: default 120000, max 600000.
> - `run_in_background` runs detached; it keeps running across turns and re-invokes you when it exits.
> - Git: interactive flags not supported; use `gh` for GitHub ops; commit/push only when asked, branch first if on default branch.

**本项目适配**：引擎检测 Git Bash 可执行→回退 `child_process.spawn("bash")`；timeout 默认 120000/上限 600000 沿用官方；background 走 `BackgroundTaskRegistry`（PID+stdout 文件+task 通知）；**无沙箱**，靠 `PermissionManager.getCommandRisk`→allow/ask；超长输出 head 1000+tail 3000 截断（沿用现 `run_command` 思路）；工作目录会话级持久。

---

#### PowerShell（官方，节选要点）
> Executes a given PowerShell command with optional timeout. Working directory persists; shell state does not.
> - For terminal operations: git, npm, docker, PS cmdlets. NOT for file ops — use specialized tools.
> - Edition: Windows PowerShell 5.1 (powershell.exe). Pipeline chain `&&`/`||` NOT available — use `A; if ($?) { B }`. Ternary `?:`, `??`, `?.` NOT available. No `2>&1` on native exes. Default file encoding UTF-16 LE; pass `-Encoding utf8`. `ConvertFrom-Json` returns PSCustomObject, not hashtable.
> - Use Glob/Grep/Read/Edit/Write instead of `Get-ChildItem -Recurse`/`Select-String`/`Get-Content`/`Set-Content`.
> - `-ErrorAction SilentlyContinue` still exits 1 for cmdlet failure; to make non-fatal use `try { ... -ErrorAction Stop } catch {}`.
> - Interactive/blocking commands (`Read-Host`, `git rebase -i`, etc.) forbidden (tool runs with -NonInteractive).
> - Multi-line strings to native exes: single-quoted here-string `@'...'@`, `'@` at column 0.
> - Avoid unnecessary `Start-Sleep`; don't retry failing commands in sleep loops.

**本项目适配**：调 `powershell.exe -NoProfile -NonInteractive -Command`；与 Bash 共用 `SpawnRunner`/`BackgroundTaskRegistry`；5.1 限制写入 description 供模型遵守；offset/timeout/截断/工作目录同 Bash。

---

#### AskUserQuestion（官方要点）
> Use only when blocked on a decision genuinely the user's to make (one you cannot resolve from the request/code/sensible defaults).
> - Users can always select "Other" for custom input; multiSelect allows multiple answers.
> - Recommended option first, label ends with "(Recommended)".
> - Reserve for decisions where the answer changes what you do next. For choices with a conventional default, pick the obvious option, mention it, and proceed.
> - `preview` field on options for ASCII mockups / code snippets / diagrams; monospace box; only single-select.
> - In plan mode, use to clarify approaches BEFORE finalizing a plan; do NOT ask "Is my plan ready?".

**本项目适配**：真实工具 → IPC `CHAT_REQUEST_ASK_USER`/`CHAT_ASK_USER_RESPONSE:<id>`（照抄 §3.1 `CHAT_REQUEST_APPROVAL` 范式）；渲染端新增 `AskUserQuestionWidget`（1-4 问、每问 2-4 选项+Other、preview 侧边对照、multiSelect）；计划模式本期未启用，文案保留但按普通提问处理。

---

#### PushNotification（官方要点）
> Sends a desktop notification in the user's terminal; if Remote Control connected, also pushes to phone. It pulls their attention — that's the cost. The benefit is they learn something worth knowing now.
> - Because an unneeded notification is annoying in a way that accumulates, err toward not sending one. Don't notify for routine progress, or to answer something asked seconds ago, or when a quick task completes. Notify when there's a real chance they've walked away and something's worth coming back for — or when explicitly asked.
> - Keep the message under 200 characters, one line, no markdown. Lead with what they'd act on ("build failed: 2 auth tests" beats "task done" or a status dump).
> - If the result says the push wasn't sent, that's expected — no action needed.

**本项目适配**：主进程 `Electron Notification` 桌面 toast，点击 `webContents.focus()`；`PushProvider` 接口默认 `DesktopNotificationProvider`，远端通道占位不实现；返 `{sent:boolean}`，`sent:false` 视作预期不重试。

---

#### Skill（官方要点）
> Execute a skill within the main conversation. When users ask to perform tasks, check if any available skills match.
> - When users reference `/<something>`, they mean a skill. Set `skill` to the exact name (no leading slash); for plugin-namespaced use `plugin:skill` form. `args` for optional arguments.
> - Available skills are listed in system-reminder messages.
> - Only invoke a skill in that list, or one the user explicitly typed as `/<name>`. Never guess names.
> - When a skill matches the request, this is a BLOCKING REQUIREMENT: invoke the Skill tool BEFORE any other response about the task. Never mention a skill without calling this tool. Don't invoke a skill that is already running.
> - Not for built-in CLI commands (`/help`, `/clear`, etc.).
> - If a `<command-name>` tag is in the turn, the skill has ALREADY been loaded — follow instructions directly instead of calling again.

**本项目适配**：`SkillManager.getSkills(workspaceRoot)` 取可用清单（扫描 `~/.codez/skills` + `<workspace>/.skills`，`SKILL.md`/`.skill.md` frontmatter `name/description/triggers`）；`SkillTool.execute(args)` 返回命中 SKILL.md 正文，未命中回错并列出 ≤30 个清单；AgentRunner 对 Skill 一律 `allow` 不二次 ask；**保留**现有 `<skills_instructions>` prompt 提示与 `parseSlashCommand` 的 `/<skill>` 内联路径，二者并存。

---

## 4. 文件操作设计

### 4.1 Read

- **职责**：读本地文件，cat -n 行号、单文件预算、截断、SHA256、5MB 上限、工作区前缀校验、二进制检测——继承现有 `ReadFilesTool`。
- **新增——哈希去重**：维持一个会话内"已读指纹表" `{ fileAbsPath: { sha256, readAt } }`（存于 main 进程内存，按 sessionId 分桶）。execute 流程：
  1. 读盘→算 sha256。
  2. 查表：若 `(fileAbsPath, sha256)` 命中且内容哈希未变 → **不返回原文**，只返回：
     `Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.`
  3. 未命中：写表，正常返回。
- **参数**：`file_path`(必填,绝对路径) `limit` `offset` `pages`(占位，本期 PDF 不实现，传则忽略并提示)。沿用现有 budget 参数（`maxCharsPerFile/maxTotalLines/maxTotalBytes`）作可选。
- **裁剪原则**：当用户在 prompt 用 `@file` 时，客户端预读会作为"伪 Read 回放"注入 systemInstruction（与 v101 观察一致），同时写指纹表 → 模型后续显式 Read 命中即被拦截，与 Claude Code 行为对齐。
- **图片/PDF**：本期继续二进制检测后返回错误字符串；不引 base64 / pdf-parse。`pages` 参数在 schema 保留但工具忽略并附注。

### 4.2 Edit

- **职责**：精确字符串替换，单点。`apply_patch` 现 `edits[][{targetContent,replacementContent}]` 的单点化命名。
- **契约**：必须本会话先 Read 过（沿用 `apply_patch` 的 SHA256 校验链），`old_string` 须在文件中唯一匹配（匹配失败回错），`replace_all` 全替换。匹配时须先剥 Read 返回的"`<行号>\t`"前缀。
- **与事务衔接**：完全复用 `EditTransactionService`、`expectedHash` 强校验、`rollback_last_edit` 回滚链，行为等价于 `apply_patch` 的 `edits` 单元素调用。
- **参数**：`file_path` `old_string` `new_string` `replace_all?`。

### 4.3 Write

- **职责**：整体覆写文件。`apply_patch` 现 `fullOverwrite + newContent` 的命名。
- **契约**：新建可直接写；覆盖已有须本会话先 Read；都走事务，可回滚。
- **参数**：`file_path` `content`。

### 4.4 Glob

- **职责**：快速文件路径匹配。支持 `**/*.js` 等模式，按修改时间排序返回匹配路径。
- **引擎**：`@vscode/ripgrep` 的 `rg --files`（含 `--glob` 过滤），回退 `fast-glob`；优先 ripgrep。
- **参数**：`pattern`(必填) `path?`。

### 4.5 Grep

- **职责**：内容检索（ripgrep 封装）。`output_mode: content|files_with_matches|count`，支持 regex、`glob`/`type` 过滤、`-A/-B/-C/-n/-i/-o/--multiline/head_limit/offset`。
- **引擎**：`@vscode/ripgrep` 子进程；按描述输出。
- **参数**：`pattern`(必填) + Claude 的全集（`output_mode` 等）。
- **与 search 关系**：`search` 保留供现有调用方（含渲染端 timeline 解析）；`search type=text` 内部委托给 Grep；最终 alias 收口。

### 4.6 NotebookEdit

- **职责**：Jupyter `.ipynb` v4 notebook 单元格的 `replace/insert/delete`。
- **实现**：零依赖手写 .ipynb v4 JSON 读写（`nbformat:4, nbformat_minor:5`，cell `cell_type/source/outputs/metadata`）。无第三方 notebook 库。
- **契约**：须先 Read 该 `.ipynb`（Read 对 `.ipynb` 也以 cell+output 渲染——本设计约束 Read 对 `.ipynb` 特化渲染以支撑它，但仍是文本，不算"图片/PDF 入能力")。`cell_id` 自 Read 输出中 `<cell id="...">` 取；`replace/delete` 必填 `cell_id`；`insert` 可省 `cell_id` 表示插到开头。
- **参数**：`notebook_path`(必填,绝对) `new_source`(必填,对 replace/insert) `cell_id?` `cell_type?` `edit_mode?`(replace/insert/delete 默认 replace)。

> Read 对 `.ipynb` 特化：读出 cell+output 作为带 `<cell id>` 的文本块——这与"不改二进制检测/无 base64/PDF"不冲突，仍是纯文本渲染。

---

## 5. Shell / 命令执行设计

### 5.1 Bash

- **引擎**：优先 Git Bash（检测 `git/bin/bash.exe` 或环境 `EXEPATH/bash.exe`），回退 `child_process.spawn`。POSIX 语义（避免 cmd.exe 与 PowerShell 语法混入）——与 Claude `Bash` 一致。
- **能力**：`timeout`（默认 120000ms、上限 600000ms）、`run_in_background`（返回 PID/日志路径，跨轮次存活，遇退出/超时通过 task 通知）、`description`、`dangerouslyDisableSandbox`（占位 false，本期无沙箱）。
- **输出**：流式 stdout/stderr 收集，超长截断（head 1000 + tail 3000 + 系统注，沿用现 `run_command` 思路），返回 JSON `{command, exitCode, stdout, stderr, timedOut, background, pid, truncated}`。
- **工作目录**：会话级持久（与现 `run_command` 一致）。
- **约束**：沿用现 `run_command` 描述——不建议用 Bash 跑 `find/grep/cat/head/tail/sed/awk/echo`（指向专用工具），仅做终端操作。
- **参数**：`command`(必填) `description?` `timeout?` `run_in_background?` `dangerouslyDisableSandbox?`。

### 5.2 PowerShell

- **引擎**：`powershell.exe -NoProfile -NonInteractive -Command`。Windows PowerShell 5.1 限制（无 `&&` / 三元 / `??` / 重定向原生 stderr 易错）写入工具 description 供模型遵守。
- **能力**：与 Bash 同构——`timeout`/`run_in_background`/流式/截断/工作目录持久。
- **参数**：`command`(必填) `description?` `timeout?` `run_in_background?` `dangerouslyDisableSandbox?`。
- **运行**：与 Bash 共用一个 SpawnRunner 私有实现，只换 `shell` 解释器与换行/转义策略；background 任务复用同一后台任务表与 `TaskStop`。

### 5.3 公共后台任务管理

为 Bash/PowerShell background 引入轻量 `BackgroundTaskRegistry`：`{ pid, stdoutFile, stderrFile, startedAt, shellType }`，跨轮次存活，退出/超时通过现 task 通知机制兜底。**本期不做 `TaskStop`（Task* 工具全量留空）**——后台进程的终止在 prompt 文本层面由模型用 `Bash` 内置 kill（如 `kill <pid>` / `Stop-Process`）自行完成（写入工具 description）；本期不做 `Monitor`，但为它留同名 task-id 空间。

### 5.4 PermissionManager 行为

- `checkToolPermission`：
  - `Read/NotebookEdit/Glob/Grep/Skill` → `allow`（只读/无破坏）。
  - `Edit/Write` → 沿用现写工具策略：在 workspace 内 `allow`，越界 `deny`。
  - `Bash/PowerShell` → 复用现 `getCommandRisk`（safe→allow, 其余 ask）。
  - `AskUserQuestion` → `ask`（必停下问用户）但作为"已授权工具"显式起 UI，不沿用通用 deny 路径。
  - `PushNotification` → `allow`。
- 死引用清理：移除 `write_to_file / replace_file_content / multi_replace_file_content` 行；新增 `Edit/Write` 映射。

---

## 6. 用户交互与 Skill 设计

### 6.1 AskUserQuestion

- **契约**：LLM 调用 `AskUserQuestion({questions:[{question, header, options:[{label,description,preview?}], multiSelect}]})`；AgentRunner 中断各路工具执行、向渲染端发请求并 `await` 用户答复；用户答完作为 `tool_result` 回灌（结构化 `answers` + 可选 `annotations`）。
- **IPC**：新增 `CHAT_REQUEST_ASK_USER`（main→renderer）与 `CHAT_ASK_USER_RESPONSE:<requestId>`（renderer→main, `ipcMain.handleOnce`），套路完全照搬现 `CHAT_REQUEST_APPROVAL`。
- **渲染端**：新增 `AskUserQuestionWidget`（chat 组件目录），1–4 个问题、每问 2–4 选项 + 自动 "Other"、单选支持 `preview` 侧边对照、多选用 `multiSelect`。点决议后 `window.api.chat.respondAskUser(requestId, answers)`。
- **权界**：与 `PermissionApprovalWidget` 共存。AskUser 是"模型主动问"，Permission 是"工具风险授权"，两类卡片独立渲染。
- **plan-mode 注记**：Claude 在 plan mode 内用 AskUserQuestion 澄清需求；本期计划模式未启用，文案保留，行为等同普通提问。

### 6.2 PushNotification

- **契约**：`PushNotification({message, status})`；显式克制：描述里硬写"不要为普通进度/几秒钟就能看到的事发，仅在用户可能离开 + 值得回来查看/明确要求时发；<200 字单行"。
- **实现**：主进程 `Electron Notification`（`new Notification({ title, body })`），点击 `onClick` 回主窗口 `webContents.focus` 拉回焦点；`status` 映射 title/图标（info/success/warning/error）。
- **PushProvider 接口**：`interface PushProvider { send(title, body, status): Promise<{sent:boolean}> }`；默认实现 `DesktopNotificationProvider`（Electron Notification）；留接口位供未来 `RemoteControlProvider` 注入；未注入时恒走桌面。
- **结果回灌**：返回 `{sent:boolean, note?:string}` 字符串；"未发送"属预期，提示模型无需重试。

### 6.3 Skill

- **契约**：`Skill({skill, args?})`，`skill` 必须出现在可用清单（来自 `SkillManager` 扫描 `~/.codez/skills` 与 `<workspace>/.skills`）；命中即把该 `SKILL.md` 正文作为字符串回灌给模型；不命中回错。
- **保留双路径**：`chat.handlers.ts` 现有 `<skills_instructions>` 提示与渲染端 `parseSlashCommand` 的 `/<skill>` 内联路径**不动**；Skill 工具是新增的"运行期取正文"通道。
- **AgentRunner 注记**：遇 `Skill` 调用优先放行（`allow`），不二次请求权限；要求模型在"匹配 skill 的请求"上 BLOCKING（先调 Skill 再作其它响应）——写入工具 description。

---

## 7. 架构改动总览

- **`ToolManager.registerBuiltinTools`**：从 9 → 11+5=新增 11、保留 5、旧 5 改 alias。注册顺序：先注册新工具，再注册 alias（同 Map，key 旧名→委托实例），确保新名优先。
- **`chat.handlers.ts`**：`<available_tools>` 文本列表与 `<skills_instructions>` 同步加新名；保留旧名占位（alias 体现）。
- **`AgentRunner.run`**：
  - verification-loop：`filesModifiedInSession` 命中条件增加 `Edit/Write`（与 `apply_patch` 并存）。
  - resume-state：`update_resume_state` 不变。
  - 工具结果包裹沿用 `{ok,data|error}`。
- **`PermissionManager`**：见 §5.4；`createPermissionRequest` 扩展支持 `AskUserQuestion` 的重型请求类型（带 `questions`）。
- **`Read 指纹表`**：新增 main 进程内 `ReadFingerprintStore`（按 sessionId 分桶，会话结束清理），`@file` 预读路径与 Read 工具共同读写。
- **`BackgroundTaskRegistry`**：main 进程内单例，承载 Bash/PowerShell 跨轮次后台进程。
- **`IPushProvider`**：main 进程内接口 + `DesktopNotificationProvider` 默认实现。
- **`SkillTool`**：`SkillManager` 增 `getSkillContent(name)` 返回正文。
- **渲染端**：新增 `AskUserQuestionWidget.tsx` 与配套 CSS；`ChatArea` 接线；preload 增 `chat.respondAskUser`、`chat.onAskUserRequest`；IPC channels 增 `CHAT_REQUEST_ASK_USER` / `CHAT_ASK_USER_RESPONSE`。

---

## 8. 数据流

### 8.1 AskUserQuestion

```
LLM → AskUserQuestion(questions)
AgentRunner → PermissionManager.ask
AgentRunner → callbacks.onAskUserRequest(req)  (chat.handlers)
            → ipcMain.handleOnce(CHAT_ASK_USER_RESPONSE:<id>)
            → sender.send(CHAT_REQUEST_ASK_USER, streamId, req)
renderer: AskUserQuestionWidget 渲染 → 用户选
        → window.api.chat.respondAskUser(id, answers)
main: handleOnce 解析 → 返回 tool_result(JSON answers)
AgentRunner 继续下一轮
```

### 8.2 Background shell

```
LLM → Bash(command, run_in_background:true)
AgentRunner → permission(allow/ask)
SpawnRunner.spawn → BackgroundTaskRegistry.add({pid, stdoutFile, stderrFile, startedAt, shellType})
工具返回 JSON {background:true, pid, stdoutFile} 给 LLM
...跨轮分脉...
进程退出/超时 → 现有 task 通知机制兜底
LLM 终止 → Bash 自行 kill(pid) / Stop-Process(pid)  (本期无 TaskStop 工具)
```

> 后台 PID 仅在 prompt 文本层面可被后续轮引用；本期 Task* 工具留空，故"主动终止"以 Bash/PowerShell 内置命令由模型自行完成（工具 description 写明）。

### 8.3 Read 去重

```
LLM → Read(file_path)
Read.execute → 读盘 + sha256 → 查 ReadFingerprintStore
  命中(哈希未变) → "Wasted call — file unchanged..."
  未命中       → 写表 + 返回原文(行号/截断/SHA)
@file 预读    → 写表（同一 Store），与上互锁
```

---

## 9. 错误处理与边界

- **Edit old_string 不唯一**：回错并提示模型用 `replace_all` 或扩大 old_string 上下文——对齐 Claude 行为。
- **Write/Edit 越界 workspace**：返错并拒绝。
- **Read 命中二进制**：返回 `Cannot read binary file.`（沿用现措辞）；图片/PDF 不在本期。
- **Glob/Grep ripgrep 缺失**：`@vscode/ripgrep` 是 npm 包，install 时随平台下载二进制；加载失败回退 `fast-glob`（Glob）/ 报错（Grep，不回退纯 JS——已明选 ripgrep）。
- **AskUserQuestion 超范围**： fewer than 1 或多于 4 问题 → execute 直接返错；`options` 每问 2–4 个、强约束在 execute 内校验。
- **Skill 名不存在**：返错且列出当前可用清单（限制 30 个左右）。
- **timeout/background 互动**：background 模式下 `timeout` 仅作为"软提示阈值"，进程不主动 kill——与 Claude `Monitor`/`Bash` 分工一致；超 timeout 后台计时记审计不杀进程（背景模式持续到退出或用户 Bash kill）。
- **上下文预算**：Read/Grep/Glob 大输出沿用现 `ContextManager.truncateToolOutput`；AskUserQuestion 答案天然小，不截断。

---

## 10. 测试策略

- **工具单测**（`tests/main/tools/`）：每个新工具参数校验、成功路径、错误路径；Read 去重的命中/未命中/`@file` 互锁；Edit 唯一匹配/不唯一/未先 Read；Glob/Grep ripgrep 调用与回退；NotebookEdit 三模式 + v4 读写回归；Bash/PowerShell timeout/background/截断；Skill 命中/未命中；PushNotification 桌面触发。
- **集成**：`AgentRunner` 端到端单轮（mock provider 回 `AskUserQuestion`，验 main↔renderer IPC 双向、tool_result 回灌正确）；`@file` + `Read` 互锁指纹场景。
- **.PermissionManager 单测**：新增映射 + 死引用清理后回归。
- **手动验收**：真实会话里`@file 分析文件` 模型不会再 cat fallback；AskUserQuestion 渲染端选完答案后流程继续；PowerShell 在 Windows 上 5.1 表现正常；后台命令跨轮存活。

---

## 11. 每工具验收标准（可断言）

每条都应是单测/集成测或手动验收能判"通过/不通过"的断言。

### Read
- 必填 `file_path` 缺失 → execute 返错（JSON `{ok:false}`）。
- 首次读未读过的文件 → 返回带行号+SHA256 的正文，且 `ReadFingerprintStore` 写入 `(absPath → sha256)`。
- 同一 `(absPath, 首次返回的 sha256)` 再次 Read → 返回字符串 `Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.`，不返回正文。
- 文件内容改变后再次 Read（sha256 不同）→ 正常返回新正文并更新指纹。
- 客户端 `@file` 预读一次后，模型显式 Read 同文件 → 同样命中 `Wasted call`（指纹互锁）。
- 文件 > 5MB → 返错；首 512 字节含 NUL → `Cannot read binary file.`。
- 工作区外的绝对路径 → 返错并拒绝。
- 截断场景：超过 `maxTotalLines(1200)`/`maxTotalBytes(120000)` 时附 `[System Note: ...]` 并继续输出 omitted 元数据。

### Edit
- 未先 Read 该文件（指纹表无记录）→ 返错并提示先 Read。
- `old_string` 在文件中 0 次 → 返错"未匹配"；>1 次 → 返错"不唯一，用 replace_all 或扩大 old_string"。
- 命中唯一 → 写入成功，文件读回内容已替换，走 `EditTransactionService`（含 `transactionId`），`rollback_last_edit` 可回滚。
- `replace_all:true` + 存在多处 → 全替换成功。
- `old_string` 含 Read 返回的 `数字\t` 前缀 → 校验前自动剥除前缀再匹配（不因前缀导致 0 匹配）。
- workspace 外文件 → 拒绝。

### Write
- 新建文件（不存在）→ 直接写入成功，事务覆盖。
- 覆盖已存在但本会话未 Read 的文件 → 返错"须先 Read"。
- 覆盖已 Read 的文件 → 整体覆写成功，可 `rollback_last_edit`。
- workspace 外 → 拒绝。

### NotebookEdit
- `replace` 模式 + `cell_id` 命中 → cell 源被 `new_source` 替换，文件 v4 结构不变（nbformat/minor 不被改写）。
- `insert` 模式 + 缺省 `cell_id` → 在开头插入新 cell；`cell_type` 缺省按 code。
- `insert` 给定 `cell_id` → 在该 cell 之后插入；未找到 `cell_id` → 返错。
- `delete` 模式 → cell 被移除；`cell_id` 未命中 → 返错。
- 未先 Read 该 notebook → 返错。
- 重新 Read 该 .ipynb → 渲染为 `<cell id="...">` 文本块供下一轮 NotebookEdit 取 id。

### Glob
- `pattern:"**/*.ts"` 命中 workspace 内 TS 路径，按 mtime 排序返回。
- `pattern` 非法 → 返错。
- `path` 指定子目录 → 仅该子树匹配。
- ripgrep 不可用 → 回退 `fast-glob` 并返回一致结果（不抛错）。

### Grep
- `output_mode:"files_with_matches"` + 命中 → 返回路径列表（默认）。
- `output_mode:"content"` + `-n:true` → 返回带行号的匹配行。
- `glob:"**/*.tsx"` 过滤生效；`type:"rust"` 等效 `--type`。
- `-A 2 -B 1` 上下文出现。
- `multiline:true` 支持跨行模式。
- `head_limit:N` 限制输出条数。
- ripgrep 不可用 → Grep 返错（不回退纯 JS，按已明选）。

### Bash
- `command:"echo hello"` 前台 → 返回 `{exitCode:0, stdout:"hello\n"}`。
- `timeout:1000` + `command:"sleep 5"` → `{timedOut:true}`。
- `run_in_background:true` + `command:"sleep 3"` → 立即返回 `{background:true, pid, stdoutFile}`，3s 后现有 task 通知机制触发退出事件。
- 超长输出（> 阈值）→ 截断保留 head 1000 + tail 3000 + `[System Note]`。
- 工作目录跨多轮 Bash 调用持久（同主进程会话内）。
- Git Bash 不可用 → 回退 `spawn("bash")`；都不可用 → 返错。

### PowerShell
- `command:"Write-Output hi"` → `{exitCode:0, stdout:"hi\r\n"}`（或经边界规范化）。
- `--NoProfile -NonInteractive` 确认无 profile 加载、无交互阻塞。
- `run_in_background:true` 同 Bash 行为。
- description 内包含 5.1 限制（无 `&&` / 三元 / `??`），模型可见。

### AskUserQuestion
- 1 个问题 2 个选项 → 渲染 `AskUserQuestionWidget`，显示 2 选项 + 自动 "Other"。
- 4 个问题（上限）正常；>4 → execute 返错。
- 每问 `options` <2 或 >4 → execute 返错。
- 任一问 `multiSelect:true` → 多选可选多个。
- 单选选项含 `preview` → 渲染端侧边对照显示。
- 用户决议后 `tool_result` 为结构化 `answers`（每个 `question` → 选中 `label` 或 Other 文本）回灌，AgentRunner 下一轮继续。
- 用户长时间不答复 → 进程不卡死（IPC 超时/UI 关闭返回空答案作安全默认）。
- 与 `PermissionApprovalWidget` 同时存在互不干扰。

### PushNotification
- `PushNotification({message, status:"success"})` → 触发 Electron Notification（主进程单测用事件断言可注入 provider）。
- 默认 `DesktopNotificationProvider.send` 返回 `{sent:true}`；远端未注入时同上。
- 点击 → 主窗口 `webContents.focus()` 被调用。
- 整条消息 <200 字（execute 内不做强制裁剪，文案写在 description 提示模型）。

### Skill
- `Skill({skill:"existing-skill-id"})` → 返回该 SKILL.md 正文。
- 不存在名 → 返错 + 列出当前可用清单（≤30 个）。
- `/<skill>` 内联路径与 prompt 提示路径不变（既有 e2e 不回归）。
- AgentRunner 对 Skill 不二次 ask 权限（`allow`）。

---

## 12. 回归保证清单（本期不得破坏的现有行为）

实现与本 spec 任何改动，下述既有能力必须**保持原行为**，CI/手测覆盖：

- [ ] **`@file` 预读**：渲染端 `@src/...` 引用仍被展开为带原文件的 systemInstruction 注入（与现 chat.handlers 行为一致），不因新增 Read 指纹逻辑而改变文本注入面。
- [ ] **verification 闭环**：AgentRunner `:421-442` 在"文件被改但验证命令失败"时仍注入修复提示；`filesModifiedInSession` 仍能在 `Edit/Write` 被选中时置 true（alias 期 `apply_patch` 被选同样置 true）。
- [ ] **resume-state**：`update_resume_state` 写盘路径、`ContextManager.loadResumeState/saveResumeState` 不动；新工具不引入新 resume 字段。
- [ ] **edit-transaction / rollback**：`EditTransactionService.beginTransaction/commit` 链路、`rollback_last_edit` 覆盖所有事务内写入（含新 Edit/Write），跨 PID 会话恢复仍可滚。
- [ ] **permission ask 闭环**：`run_command` 风险（safe/write/network/destructive/unknown）映射与现一致；新增 `Bash/PowerShell` 复用 `getCommandRisk`。
- [ ] **approval IPC**：现有 `CHAT_REQUEST_APPROVAL/CHAT_APPROVAL_RESPONSE` 不被 AskUserQuestion 通道挤占；两个 widget 独立。
- [ ] **三 provider 映射**：OpenAI 原样 / Gemini functionDeclarations / Anthropic input_schema 不变更；新工具自动经三映射翻译。
- [ ] **system prompt 双重声明**：`<available_tools>` 与 `<skills_instructions>` 文本块仍生成；alias 期内旧名占位仍在。
- [ ] **上下文裁剪**：`ContextManager.truncateToolOutput` 对 `Read/Grep/Glob` 大输出仍生效，token 估算（CJK-aware）不被破坏。
- [ ] **保留 5 工具**：`list_files / get_project_snapshot / fast_context / rollback_last_edit / update_resume_state` 名字、schema、行为、被既有上下文文案引用处一律不变。

---

## 13. 期一/期二分界

### 期一（本 spec 范围，下次 plan 实现）

- 实现 11 个新工具 + alias 5 + 死引用清理 + 渲染端 AskUserWidget + PushNotification + SkillTool。
- 验收：现有功能（§12 回归清单全部 pass）无回归；§11 每工具验收标准全部 pass；新工具能被 LLM 选到、执行、结果正确。

### 期二（下一周期，本 spec 仅占位）

- 删除 5 个旧名 alias 文件，`ToolManager` 收口。
- 视情况评估 Read 图片/PDF、PushProvider 远端实现、Task*/计划模式/Worktree 入范围。