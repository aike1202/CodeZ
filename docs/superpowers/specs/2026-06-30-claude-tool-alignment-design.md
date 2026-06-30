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

## 11. 期一/期二分界

### 期一（本 spec 范围，下次 plan 实现）

- 实现 11 个新工具 + alias 5 + 死引用清理 + 渲染端 AskUserWidget + PushNotification + SkillTool。
- 验收：现有功能（verification-loop/resume-state/transaction/permission/`@file`）无回归；新工具能被 LLM 选到、执行、结果正确。

### 期二（下一周期，本 spec 仅占位）

- 删除 5 个旧名 alias 文件，`ToolManager` 收口。
- 视情况评估 Read 图片/PDF、PushProvider 远端实现、Task*/计划模式/Worktree 入范围。