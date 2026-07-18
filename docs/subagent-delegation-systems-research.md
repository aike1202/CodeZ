# 子智能体委派机制与提示词调研报告

> 调研日期：2026-07-18
> CodeZ 源码目录：`F:\MyProjectF\CodeZ`
> Grok Build 源码目录：`F:\MyProjectF\grok-build`
> Claude Code 恢复源码目录：`F:\MyProjectF\Claude-Code`
> Codex 证据来源：`C:\Users\asus\.codex\sessions` 中的本地 rollout 日志
> 状态：调研完成，尚未进入代码改造阶段

## 1. 调研目标

本报告回答以下问题：

1. CodeZ 中一次简单的“这是什么项目”请求为何触发多个 Explore 子智能体。
2. 该请求实际创建了多少 Task、多少子智能体，是否真的需要“一次性派发四个智能体”。
3. Grok Build、Claude Code 和 OpenAI Codex 分别有哪些子智能体或协作角色。
4. 三套系统如何提示主智能体进行委派，如何约束子智能体的范围、权限、并发和上下文。
5. CodeZ 当前实现中哪些设计已经正确，哪些连接或运行时约束没有生效。
6. CodeZ 应借鉴哪些机制，以及推荐的角色、提示词和预算策略。

本报告只记录分析和建议，不修改 Agent、Prompt、Tool、Permission 或运行时实现。

完整提示词、请求上下文、SubAgent 输入输出和工具源码档案位于 [main-agent-prompts](research/main-agent-prompts/README.md)。其中 [subagent-io-and-interaction.md](research/main-agent-prompts/subagent-io-and-interaction.md) 专门回答主 Agent 与子 Agent 如何启动、回传、发消息和恢复；[context-layer-comparison.md](research/main-agent-prompts/context-layer-comparison.md) 记录 system 之外九层上下文及完整日志 schema。

## 2. 结论摘要

### 2.1 对截图对应行为的判断

“这是什么项目”不应该默认并发派发多个 Explore。

对这类项目介绍请求，推荐策略是：

- 默认由主智能体直接读取 README、包清单、主要入口和一层目录结构后回答。
- 如果仓库规模或迁移状态明显复杂，可以补充一个 `quick Explore`。
- 只有用户明确要求并行，或主智能体已经识别出两个以上真正独立且有明显收益的调查问题时，才并发派发多个子智能体。

本次记录中创建了 4 个 Task 卡片，但实际只派发了 3 个 Explore。第 4 个 Task 由主智能体继续处理。因此，UI 上的 4 个任务不能解释为 4 个子智能体。

### 2.2 本次异常的直接后果

本次简单请求导致：

- 主智能体创建 4 个持久 Task。
- 主智能体在同一个模型响应中调用 3 次 `spawn_agent`。
- 一个 `exhaustive` Explore 累计产生约 148.5 万字符工具输出。
- 该 Explore 最终因模型输入超过硬限制而失败。
- 主智能体自身又累计产生约 120.6 万字符工具输出。
- 主智能体发起多轮 TypeScript、Renderer、Rust workspace、Clippy 和格式检查。
- 多条 PowerShell 命令因运行时授权收据过期或 Shell 语法分类失败而没有执行。

问题不是单一的 Explore 提示词写得不够严格，而是委派触发、预算、累计输出、Scope 强制、验证策略和 Prompt 接线同时存在缺口。

### 2.3 推荐的 CodeZ 角色集合

当前 Tauri/Rust 产品路径只保留以下两个内置角色是合理的：

1. `Explore`：只读代码调查。
2. `Reviewer`：实现完成后的独立验收审查。

不建议重新引入产品级 `Plan`、`ExecutionPlanner` 或 `Executor`：

- Plan 应由主智能体完成，避免产生第二套理解和计划所有权。
- 并行实现如果未来需要，可以作为受控的 Worker 执行模式，而不是默认可见的规划角色。
- 当前 Rust registry 已通过测试明确排除 Plan-only 子智能体。

## 3. 调研边界与证据可信度

### 3.1 源码版本

| 项目 | 提交 |
|---|---|
| CodeZ | `f76537bb6d4f7b066f4a6519e44fff1c9833b533` |
| Grok Build | `8adf9013a0929e5c7f1d4e849492d2387837a28d` |
| Claude Code 恢复源码 | `b78dd22a091b717c8938ab98c736bc04825a8ee8` |

Claude Code 仓库是从 source map 恢复的源码树，不是 Anthropic 原始开发仓库。报告只把能够从恢复源码直接验证的内容作为源码事实；受 feature flag、GrowthBook、`USER_TYPE` 或构建变体控制的行为会单独说明。

### 3.2 证据分类

本报告使用三类证据：

- **运行事实**：CodeZ session、Agent runtime 和 ledger 中实际持久化的事件。
- **源码事实**：当前文件中可直接定位的 Prompt、Tool schema、角色 registry 和运行时限制。
- **建议**：基于运行事实和对标设计提出，尚未实现。

### 3.3 CodeZ 日志位置

截图对应会话为 `1784299678287_8eao9s`：

- 用户会话：`C:\Users\asus\.codez\sessions\1784299678287_8eao9s.json`
- Agent 生命周期：`C:\Users\asus\.codez\agent-runtime\1784299678287_8eao9s.json`
- 上下文快照：`C:\Users\asus\.codez\session-runtime\1784299678287_8eao9s\snapshot.json`
- 完整执行账本：`C:\Users\asus\.codez\session-runtime\1784299678287_8eao9s\ledger.jsonl`
- 应用日志：`C:\Users\asus\.codez\logs\codez.2026-07-17.jsonl`

## 4. CodeZ 异常会话复盘

### 4.1 用户请求

会话标题和首个请求均为：

```text
这是什么项目
```

这是一个开放但简单的项目介绍请求。它没有要求：

- 创建任务计划。
- 并发调查。
- 派发子智能体。
- 修改代码。
- 运行测试或构建。
- 验证当前工作树可发布。

### 4.2 TaskCreate 与 Agent spawn 是两套概念

主智能体首先创建 4 个 Task：

| Task | 内容 | 实际执行者 |
|---|---|---|
| t1 | 整体架构与启动链路 | Explore `architecture-analysis` |
| t2 | Agent、Chat、Tool 与权限运行时 | Explore `runtime-analysis` |
| t3 | 前端产品形态与状态管理 | Explore `frontend-analysis` |
| t4 | 测试、工程质量与风险 | 主智能体 |

Task 是持久进度记录，不等于 Agent。该会话实际 Agent 数量为 3。

这一点对 UI 和运行时都很重要：Task 数量不应暗示并发槽位或子智能体数量，Task 拆分也不应自动触发同等数量的 Agent。

### 4.3 三个 Explore 在同一轮派发

ledger 中 `sequence = 24` 的同一个 assistant message 包含三次 `spawn_agent`：

| taskName | depth | Scope | allowShell |
|---|---|---|---:|
| `architecture-analysis` | `normal` | Electron、Tauri、contracts/core、迁移文档 | false |
| `runtime-analysis` | `exhaustive` | Rust runtime/providers/platform/storage/MCP/Tauri | false |
| `frontend-analysis` | `normal` | `src/renderer/src` | false |

三个简报本身写得相对完整：包含问题、排除项、目录和只读要求。异常主要发生在“是否应该派发”和“派发后允许消耗多少资源”。

### 4.4 实际成本

| Agent | 工具调用数 | 工具结果字符数 | 运行时长 | 最终状态 | 报告字符数 |
|---|---:|---:|---:|---|---:|
| `architecture-analysis` | 61 | 820,215 | 901.7 秒 | completed | 16,001 |
| `runtime-analysis` | 73 | 1,485,049 | 277.2 秒 | failed | 66 |
| `frontend-analysis` | 40 | 876,636 | 471.7 秒 | completed | 18,267 |

`runtime-analysis` 的终止报告为：

```text
## SubAgent Failed

The model context exceeds its hard input limit
```

该 Agent 的输出构成主要是：

- 34 次 Read，约 951,556 字符。
- 33 次 Grep，约 523,242 字符。
- 6 次 Glob，约 10,251 字符。

这表明当前 `exhaustive` 没有形成有效的总量预算。单次工具结果即使有限制，累计结果仍可持续堆积到模型硬上限。

### 4.5 主智能体重复调查

主智能体没有只等待三个调查结果，而是继续执行大量相同性质的 Read、Grep、Glob 和 PowerShell：

- 共记录 100 个主 Scope 工具结果。
- 工具结果累计约 1,206,210 字符。
- Read 约 764,378 字符。
- Grep 约 258,699 字符。
- PowerShell 23 次。

因此，虽然委派提示要求“不要重复子智能体工作”，实际运行中父子调查范围仍显著重叠。

### 4.6 不必要的验证和授权失败

主智能体随后尝试执行：

- `npm run typecheck`
- `npm run check:architecture`
- `npm run build:renderer:tauri`
- `npm test`
- `npm run build`
- `cargo test --workspace --all-targets --locked`
- `cargo test --workspace --lib --tests --locked`
- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`

对于“这是什么项目”的只读介绍，这些命令不能提高核心回答的必要可信度，反而扩大耗时、授权和工作树干扰风险。

多条命令带有完整 PowerShell UTF-8 初始化前缀。运行时日志中一部分失败被记录为：

```text
Error: the authorization receipt expired before execution
```

用户界面同时显示 Shell 语法分类器不能完整解析：

```text
powershell-invocation:[System.Text.UTF8Encoding]::new($false)
```

后续相同命令又有成功记录。因此这不是 `npm` 或 `cargo` 自身失败，而是命令包装、Shell 分类和授权收据生命周期之间的交互问题。

## 5. Grok Build 子智能体机制

### 5.1 内置角色

Grok Build 内置三个 Agent 类型：

| 类型 | 用途 | 默认能力 |
|---|---|---|
| `general-purpose` | 复杂、多步、可能修改代码的任务 | 全工具 |
| `explore` | 快速、只读代码探索 | Read、List、Search |
| `plan` | 只读架构分析和实施计划 | Read、List、Search |

项目或用户配置可以增加自定义角色，也可以按名称覆盖内置角色。

### 5.2 通用子智能体提示

文件：`F:\MyProjectF\grok-build\crates\codegen\xai-grok-agent\templates\subagent_prompt.md`

核心内容非常短：

```text
You are a Grok Build subagent, a focused worker delegated a specific task.

Your job is to complete the assigned task directly and efficiently.
Do not broaden scope beyond what was asked.
```

其余内容主要定义工具使用、项目指令文件、后台任务和格式约定。角色行为通过额外的 `role-instructions` 和 `persona` 分层注入。

### 5.3 Explore 提示

文件：`F:\MyProjectF\grok-build\crates\common\xai-tool-types\src\task.rs:713`

关键约束：

- 明确标记 `READ-ONLY MODE`。
- 不得创建、修改或删除文件。
- 如果执行工具存在，只允许只读命令。
- 根据调用方指定的 thoroughness 调整搜索方式。
- 最大化独立工具的并行调用。
- 默认只搜索 workspace。
- 工作区内搜不到时必须报告，不得自行扩展到工作区外。

### 5.4 Plan 提示

Plan 是只读软件架构角色，要求按 Understand、Explore、Design、Detail 四步工作，并在结尾列出 3 至 5 个关键实现文件。

该角色可以用于理解 Grok 的角色设计，但不建议因此把 Plan 重新带回 CodeZ 产品路径。

### 5.5 权限、隔离与恢复

Grok 将以下概念分开：

- Agent type：任务类型。
- Persona：行为风格和专业身份。
- Capability mode：`read-only`、`read-write`、`execute`、`all`。
- Isolation：共享目录或 worktree。
- Model/reasoning：独立的模型和推理配置。

它还支持：

- `resume_from`：继续已完成子智能体的完整会话。
- 后台执行和结果获取。
- worktree 隔离修改。
- 最大嵌套深度 1。

### 5.6 明确的禁止使用场景

用户指南直接列出：

- 父智能体可直接完成的简单任务。
- 需要与用户频繁来回确认的任务。
- 上下文准备成本高于并行收益的任务。

这是 CodeZ 当前主委派 Prompt 最需要借鉴的部分之一。

## 6. Claude Code 子智能体机制

### 6.1 内置角色

恢复源码中可以确认以下角色：

| 类型 | 启用条件 | 用途 |
|---|---|---|
| `general-purpose` | 基础内置 | 复杂调查和多步任务 |
| `Explore` | feature flag | 快速代码搜索 |
| `Plan` | feature flag | 只读实施计划 |
| `claude-code-guide` | 非 SDK 入口 | Claude Code、SDK、API 问答 |
| `statusline-setup` | 基础内置 | 配置状态栏 |
| `verification` | 实验开关 | 修改完成后的独立验证 |

此外还支持 `.claude/agents/*.md` 和插件 Agent。

### 6.2 主智能体委派提示

文件：`F:\MyProjectF\Claude-Code\src\tools\AgentTool\prompt.ts`

最有价值的不是角色数量，而是对主智能体的限制。

明确禁止派发的场景包括：

- 已知具体文件路径。
- 只搜索一个明确类或符号。
- 只涉及一个文件或 2 至 3 个文件。
- 任务不符合任何 Agent 的描述。

它要求把子智能体当成“刚走进房间的聪明同事”进行简报：

- 解释目标和原因。
- 提供已知事实和已排除项。
- 提供足够上下文，使其能做判断。
- 如果需要短报告，明确限制字数。
- 查找任务给精确命令，调查任务给问题。

关键原则是：

```text
Never delegate understanding.
```

父智能体必须先完成理解和综合，不能只写“调查后顺便修复”。

### 6.3 Explore 提示

文件：`F:\MyProjectF\Claude-Code\src\tools\AgentTool\built-in\exploreAgent.ts:24`

其只读约束比一般的“不要编辑”更具体：

- 禁止创建临时文件。
- 禁止重定向和 heredoc 写入。
- 禁止修改系统状态。
- 禁止安装依赖和 Git 写操作。
- 禁用 Agent 工具，防止递归委派。
- 调用方必须指定 `quick`、`medium` 或 `very thorough`。
- 外部用户默认使用更快的 Haiku 模型。
- 默认不注入完整 `CLAUDE.md`，减少无关上下文。

### 6.4 Verification 提示

文件：`F:\MyProjectF\Claude-Code\src\tools\AgentTool\built-in\verificationAgent.ts:131`

Verification 只应在以下情况使用：

- 非平凡实现已经完成。
- 修改 3 个以上文件。
- 后端、API 或基础设施发生变化。

调用方必须提供原始用户任务、修改文件和实施方法。Verification 不能修改项目，必须执行真实检查，并以以下结构结束：

```text
VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL
```

它不应在纯项目分析中触发。

### 6.5 并发提示的边界

Claude Code 源码存在构建和订阅差异：

- 用户明确要求 parallel 时，提示要求在同一个消息中发出多个 Agent 调用。
- 某些非 Pro 或内联 catalog 变体还会注入“尽可能并发启动多个 Agent”的提示。
- 后台 Agent 完成后会自动通知，明确禁止 sleep、poll 或主动反复检查。
- 前台 Agent 用于后续工作依赖其结果的研究；后台只用于真正独立的工作。

CodeZ 应借鉴其前后台依赖划分和禁止轮询，但不应照搬“尽可能多地并发”作为默认策略。

## 7. OpenAI Codex 日志中的协作机制

### 7.1 不是固定角色系统

Codex 子 rollout 的 `session_meta` 包含：

```json
{
  "thread_source": "subagent",
  "source": {
    "subagent": {
      "thread_spawn": {
        "parent_thread_id": "...",
        "depth": 1,
        "agent_path": "/root/frontend_lint",
        "agent_nickname": "Turing",
        "agent_role": null
      }
    }
  }
}
```

实际样本中的 `agent_role` 为 `null`。`Turing`、`Dalton`、`Hooke` 是运行时昵称，职责由以下字段表达：

- `task_name`
- `agent_path`
- 父智能体发送的 `message`

因此 Codex 更接近“同能力动态团队”，而不是固定 Explore、Plan、Worker 类型体系。

### 7.2 并发槽位

当前团队提示明确：

- 总并发槽位为 4。
- 主智能体占用一个槽位。
- 因此通常最多同时运行 3 个子智能体。

这解释了 Codex 日志中一次出现 3 个子智能体，而不是 4 个子智能体。

### 7.3 真实派发有明确用户授权

父 rollout 中，用户先明确要求：

```text
将不同的任务分配改不通过的子智能体去实现吧，这样快一点
```

随后父智能体派发：

- `frontend_lint`
- `media_gateway_tests`
- `evidence_retention_tests`

因此该次并行是用户明确要求的结果，不能作为 CodeZ 对任意分析请求自动三路派发的依据。

### 7.4 上下文继承

六次抽样 `spawn_agent` 均使用：

```json
{ "fork_turns": "all" }
```

它能让子智能体继承完整历史和缓存，但也增加上下文污染和重复信息。Codex 提供 `none`、有限轮数和 `all`，说明上下文继承应是显式策略，而不是无条件复制父会话。

### 7.5 当前显式委派总开关

当前 Codex 开发者提示还增加了：

```text
Do not spawn sub-agents unless the user or applicable AGENTS.md/skill
instructions explicitly ask for sub-agents, delegation, or parallel agent work.
```

这种 `explicitRequestOnly` 总开关非常适合防止简单请求误触发多 Agent。CodeZ 可以采用稍微宽松的保守模式：允许复杂调查自动派一个 Explore，但多 Agent 并行必须有明确用户意图或高收益判断。

## 8. 三套系统对比

| 维度 | Grok Build | Claude Code | Codex |
|---|---|---|---|
| 角色模型 | 固定类型 + 自定义角色/Persona | 固定内置 + 自定义 Agent | 动态任务角色，样本 `agent_role=null` |
| Explore | 内置、强只读 | 内置、强只读、快模型 | 不依赖固定 Explore 类型 |
| Plan | 内置 | 条件内置 | 无固定 Plan 子智能体 |
| Verification | 可通过自定义/通用角色实现 | 独立实验角色 | 由动态任务定义 |
| 主提示的禁止委派场景 | 文档明确 | Tool prompt 详细明确 | 当前团队模式可强制显式请求 |
| 权限 | Capability mode + Agent toolset | 工具白名单/黑名单 | 同能力 Agent，受当前工具和系统策略约束 |
| Scope | Workspace 边界提示和角色能力 | Prompt、工具集、worktree | 任务简报和工作目录 |
| 上下文继承 | 独立上下文，支持 `resume_from` | fresh Agent 或 fork | `fork_turns` 可选 |
| 恢复 | `resume_from` | `SendMessage`/resume | `followup_task`/message |
| 最大深度 | 1 | Explore/Plan 禁用 Agent 工具 | 由团队指令和槽位约束 |
| 并发 | 后台任务 + 结果工具 | 独立任务并发 | 4 个总槽位，包含主智能体 |
| 结果回传 | 单一结果消息 | 单一结果消息或结构化 verdict | 父子邮箱和独立 rollout |

## 9. CodeZ 当前实现状态

### 9.1 当前 Rust registry 方向正确

文件：`crates/codez-runtime/src/agent/registry.rs`

Rust registry 当前只注册：

- `Explore`
- `Reviewer`

测试 `builtin_registry_should_exclude_plan_only_subagents` 明确断言这两个类型。当前 `spawn_agent` schema 也只允许这两个 role。

### 9.2 Electron 旧定义仍然存在

文件：`src/main/agent/definitions/index.ts`

旧 TypeScript 路径仍列出：

- Explore
- Reviewer
- ExecutionPlanner
- Executor

这属于 Electron 基线和迁移遗留，不能据此认为当前 Tauri/Rust 产品仍应提供四种角色。分析和后续实现必须始终区分两条执行路径。

### 9.3 主委派 Prompt 没有对实际工具生效

文件：`crates/codez-runtime/src/chat/prompt/modules/worker_delegation.rs`

Prompt 文案本身已经包含正确原则：

```text
Do the work directly for simple requests, directed lookups,
or tightly sequential changes.
```

但 `is_enabled()` 只检测：

```text
SubAgentRunner
DelegateTasks
```

当前实际工具名是：

```text
spawn_agent
```

因此只要 `available_tools` 是当前真实 catalog，该模块就不会被启用。这是本次误触发最直接的 Prompt 接线问题。

### 9.4 `spawn_agent` Tool 描述过于简短

文件：`crates/codez-runtime/src/tools/builtin/agent.rs:48`

当前描述只有：

```text
Start a durable Explore or Reviewer Agent.
Creates a session-owned child Agent and returns after its supervised attempt starts.
```

它没有告诉模型：

- 哪些任务禁止派发。
- 默认最多自动派几个。
- 多 Agent 并发需要什么条件。
- Task 数量不是 Agent 数量。
- Reviewer 只能在修改完成后触发。
- 应优先复用已完成 Agent。

Registry 中虽有 `when_to_use` 和 `when_not_to_use`，但 Tool 描述没有把这些规则直接呈现给主模型。

### 9.5 Rust Agent 系统附加提示过弱

文件：`src-tauri/src/chat_runtime.rs:1424`

Explore 实际附加内容主要是：

```text
Explore read-only evidence and return a concise handoff.
```

相比 Grok 和 Claude，它缺少：

- 具体禁止操作。
- 搜索优先级。
- 停止条件。
- 工具输出预算。
- 搜不到时的行为。
- 不运行 build/test 的默认规则。
- 结构化提交契约。

工具 catalog 的确阻止 Explore 使用编辑和 spawn，但 Prompt 仍不足以控制大量 Read/Grep 和重复调查。

### 9.6 `depth` 没有成为真实预算

当前 schema 接受：

- `quick`
- `normal`
- `exhaustive`

旧 TypeScript SubAgentManager 会把它们映射为不同 loop 数，但当前 Tauri Chat Agent 复用统一的 multi-turn loop：

```text
MAX_TOOL_ROUNDS_PER_RUN = 64
```

在当前 Rust路径中，没有找到 `AgentDepth` 到工具轮数、调用数、字符数或 token 上限的映射。`depth` 被持久化并展示在简报中，但没有形成可执行预算。

### 9.7 Scope 主要仍是提示边界

`scope.directories` 当前会：

- 校验为相对路径。
- 持久化到 AgentLaunchPolicy。
- 写入 Agent system addendum。

没有找到 Read、Grep、Glob 在执行时依据该 Scope 拒绝越界读取的证据。因此它目前主要是模型提示，不是工具层强制的只读 Scope。

### 9.8 并发上限过于宽泛

文件：`crates/codez-runtime/src/agent/collaboration.rs:35`

当前进程级安全上限为：

```text
MAX_ACTIVE_ATTEMPTS = 8
```

该上限适合防止完全失控，但不能替代产品级委派策略。当前缺少：

- 单个模型响应自动派发上限。
- 单个用户请求自动并发上限。
- 用户明确要求与模型自主派发的差异化上限。
- 按角色限制并发数量。

### 9.9 输出 contract 没有完全落到实际结果

Registry 为 Explore 声明 `report`、`conclusion`、`confidence`、`filesExamined` 和 `unresolvedCount`。

实际完成的两个 Explore 在 Agent runtime 中：

- `report` 有内容。
- `conclusion` 为 `null`。
- 没有持久化 confidence、filesExamined 或 unresolvedCount。

说明 registry 的 output spec 目前更多是描述和设置数据，尚未成为当前 durable Agent loop 的强制提交协议。

### 9.10 Task Prompt 正确但约束不够硬

文件：`crates/codez-runtime/src/chat/prompt/modules/task_management.rs`

它已经写明：

```text
Do not create a task list for a simple request merely because it
contains several actions or files.
```

本次模型仍为一句简单请求创建了 4 个 Task。这说明仅有自然语言提示不能保证策略执行，需要在 TaskCreate 或上层委派控制器中增加可观测规则和软限制。

## 10. 根因分析

本次问题由以下因素叠加产生。

### 10.1 P0：委派 Prompt 接错工具名

正确的“简单任务直接做”规则没有进入使用 `spawn_agent` 的真实 Prompt。

### 10.2 P0：没有自动派发数量策略

运行时只限制最大活跃 attempts，不区分一次用户请求应自动派 0、1 还是多个。

### 10.3 P0：Depth 不控制真实资源

`exhaustive` 没有对应累计输出和 token 预算，最终直接撞到 Provider 硬限制。

### 10.4 P1：父子工作范围重叠

父智能体在派发后继续执行相同的代码调查，违背“不重复工作”的 Prompt 目标。

### 10.5 P1：Scope 不是工具边界

Scope 依赖模型自律，不能阻止搜索漂移，也不能作为稳定的成本控制基础。

### 10.6 P1：只读分析错误进入全量验证

验证 Prompt 没有把“回答项目是什么”和“验证实现是否正确”区分开，导致无修改情况下运行大规模测试和构建。

### 10.7 P1：累计工具输出缺少背压

单个结果有限制，但缺少按 Agent Scope 的累计字符、累计 token、读取文件和重复路径预算。

### 10.8 P2：结果回传过长且不结构化

完成报告分别达到 16K 和 18K 字符；中途还向父智能体发送 7K 和 12K 字符的 MESSAGE。父 Context 接收了过多过程信息。

## 11. 推荐目标策略

### 11.1 委派模式

建议提供三种产品策略，并默认使用 `conservative`：

| 模式 | 自动 Explore | 多 Agent 并发 |
|---|---:|---|
| `manual` | 0 | 仅用户明确要求 |
| `conservative` | 最多 1 个 quick/normal | 仅用户明确要求，或主智能体证明有两个以上独立问题 |
| `aggressive` | 最多 2 个 | 用户开启后允许收益驱动并发 |

默认值建议：`conservative`。

### 11.2 简单请求判定

以下任务默认由主智能体直接完成：

- 项目是什么、某个模块是什么。
- 已知文件路径读取。
- 明确类、函数或符号查找。
- 只涉及 1 至 3 个已知文件。
- 单一命令即可回答的问题。
- 父上下文已有足够证据的问题。
- 需要和用户频繁确认的问题。

### 11.3 多 Agent 并发条件

同时满足以下条件才允许模型自主并发：

1. 至少两个问题彼此独立。
2. 两个问题都需要显著工具输出。
3. 父智能体已完成初步理解和边界划分。
4. 子任务没有重叠目录或重复验收问题。
5. 并发收益明显高于上下文准备和结果综合成本。

即使满足，默认自主并发上限也应为 2。用户明确要求并行时可以提高到 3。进程级 8 attempts 只作为系统安全上限。

### 11.4 Task 与 Agent 解耦

推荐明确以下不变量：

```text
TaskCreate 不触发 spawn_agent。
Task 数量不决定 Agent 数量。
一个 Agent 可以覆盖多个相关 Task。
一个 Task 也可以完全由主智能体完成。
```

### 11.5 Depth 的可执行预算

建议先采用保守初值，再用真实 telemetry 调整：

| Depth | 工具轮数 | 工具调用数 | 累计模型可见工具结果 | 读取文件数 | 适用场景 |
|---|---:|---:|---:|---:|---|
| quick | 6 | 12 | 96 KiB | 12 | 项目入口、符号定位、短链路 |
| normal | 12 | 30 | 320 KiB | 30 | 跨模块调用链、有限架构调查 |
| exhaustive | 20 | 60 | 768 KiB | 60 | 用户明确要求的全面审计 |

还应增加：

- 单个工具结果的模型可见预览上限。
- 同一路径重复 Read/Grep 去重。
- 达到 70% 预算时提醒 Agent 综合现有证据。
- 达到 100% 时禁止继续搜索，只允许提交结果。
- 为最终报告保留独立 token 和工具轮次。

### 11.6 Scope 强制

Read、Grep、Glob 应在执行层接收已解析 Scope：

- 目标路径必须位于 `scope.directories` 之一。
- `excludeGlobs` 必须在工具执行前应用。
- 越界请求返回结构化 `AGENT_SCOPE_VIOLATION`。
- Scope 为空时才使用整个 workspace。
- 任何 workspace 外搜索都必须由父智能体显式授权。

### 11.7 Reviewer 触发

Reviewer 只在以下情况下使用：

- 项目文件发生非平凡修改。
- 主智能体已经运行与风险匹配的基础验证。
- 已有完整 changed-files 列表和原始验收标准。

以下情况禁止 Reviewer：

- 纯问题回答。
- 只读项目调查。
- 没有文件修改。
- 用 Reviewer 替代主智能体运行基础检查。

### 11.8 恢复优先于重新创建

如果已有同一 taskName 或相同问题域的完成 Agent：

1. 优先 `followup_task`。
2. 只发送发生变化的事实和新问题。
3. 保留原 Agent 的完整 Scope 和证据。
4. 不重新创建新的 Agent 进行相同调查。

### 11.9 父上下文接收策略

父智能体默认只接收：

- `conclusion`
- `confidence`
- 关键 findings
- 关键文件引用
- unresolved questions
- 工具调用和预算统计

完整报告和原始工具结果保存在独立 Agent ledger，需要时按引用读取。中途 MESSAGE 默认限制在 1 至 2 KiB，避免把子智能体过程噪声重新注入父上下文。

## 12. 推荐提示词草案

### 12.1 主智能体委派策略

```text
<delegation_policy>
Subagents are optional. Do the work directly for simple questions,
known paths, directed lookups, one-symbol searches, and tightly
sequential work.

Do not create Agents merely because a request can be split into Tasks.
Task tracking and Agent delegation are independent decisions.

Before spawning, understand the problem and write a self-contained brief
with the goal, known facts, questions, scope, exclusions, expected output,
and depth.

By default, spawn at most one Explore Agent. Spawn multiple Agents only
when the user explicitly requests parallel work, or when at least two
independent questions have clear parallel benefit and non-overlapping scope.

Never duplicate delegated work. The parent remains responsible for
interpreting results, resolving failures, and answering the user.

Use Reviewer only after non-trivial implementation changes and primary
verification. Never use Reviewer for pure analysis or question answering.

Prefer followup_task when a suitable completed Agent already exists.
</delegation_policy>
```

### 12.2 Explore 系统附加提示

```text
You are the CodeZ Explore Agent. This is a read-only investigation.

Do not create, edit, delete, move, or copy files. Do not install
dependencies, change Git state, start or stop services, or run builds and
tests unless the delegated question explicitly requires their output.

Search only within the enforced workspace scope. If the evidence is not
present there, report that it was not found instead of broadening scope.

Use Glob for file discovery, Grep for symbols and text, and Read only for
files or ranges supported by current evidence. Batch independent targets.
Do not re-read unchanged files or repeat searches already answered.

Respect the supplied depth budget. When the question is answered or the
budget is nearly exhausted, stop searching and synthesize the evidence.

Return one structured handoff containing: conclusion, confidence, concise
findings, file references, files examined, unresolved questions, and budget
usage. Do not return raw tool transcripts.
```

### 12.3 Reviewer 系统附加提示

```text
You are the CodeZ Reviewer Agent. Review only completed implementation
work against the frozen original acceptance criteria.

Do not modify project files and do not delegate. Treat the implementer's
summary and test output as claims to verify, not proof. Report proven
correctness failures first. Do not turn style preferences, future ideas,
or missing hardening into blocking findings.

Return PASS, PASS_WITH_RISKS, or BLOCKED with concrete evidence. Pure
analysis requests and requests with no changed files are out of scope.
```

## 13. 推荐实施优先级

### P0：先阻止再次失控

1. `worker_delegation` 同时识别 `spawn_agent`。
2. 将完整 `whenToUse/whenNotToUse` 注入主模型可见 Prompt 或 Tool 描述。
3. 默认单轮自动 spawn 上限设为 1。
4. 多 Agent 并发需要显式用户请求或结构化独立性判断。
5. 把 `quick/normal/exhaustive` 映射为真实工具轮数和累计结果预算。
6. 到达预算时强制进入最终提交阶段。

### P1：形成可靠边界

1. Scope 在 Read、Grep、Glob 工具层强制执行。
2. Explore/Reviewer catalog 禁止递归 spawn，并在运行时固定最大深度 1。
3. 实施父子工作去重和目录冲突检测。
4. 将 Reviewer 与“发生修改”事实绑定。
5. 纯分析请求禁止自动运行 build、test、clippy 和全量 lint。
6. 结构化结果只向父上下文投影摘要，完整报告保留在子 ledger。

### P2：完善体验和可观测性

1. UI 分开显示 Task 数和 Agent 数。
2. 展示每个 Agent 的 depth、工具调用数、累计输出和 token 使用量。
3. 展示委派原因：用户明确要求、复杂调查、独立并行或隔离输出。
4. 展示未派发原因，便于验证 simple-task guard 是否生效。
5. 支持从 UI 对已完成 Agent 发起 follow-up，而不是重新创建。
6. 对 Shell 分类失败单独显示“命令未执行”，不要与命令本身失败混淆。

## 14. 验收场景建议

后续实现至少应覆盖以下行为测试。

### 14.1 不应派发

| 请求 | 预期 |
|---|---|
| “这是什么项目” | 主智能体直接回答，最多一个 quick Explore |
| “读取 package.json 说明脚本” | 不派发 |
| “Foo 类在哪里” | 不派发，直接 Grep |
| “解释这两个文件的关系” | 不派发，直接 Read |
| “项目现在有没有未提交修改” | 不派发，直接只读 Git 状态 |

### 14.2 可以派发一个 Explore

| 请求 | 预期 |
|---|---|
| “追踪登录请求从 UI 到数据库的完整调用链” | 一个 normal Explore |
| “分析这个大型仓库的权限模型” | 一个 normal Explore |
| “全面审计上下文压缩策略” | 用户确认后一个 exhaustive Explore |

### 14.3 可以并发派发

| 请求 | 预期 |
|---|---|
| “并行分析前端性能和后端权限，两者独立” | 最多两个 Explore |
| “让不同 Agent 分别实现三个互不冲突模块” | 用户明确要求后最多三个受控 Worker |
| “并行跑前端 lint 和后端测试” | 用户明确要求后两个独立执行单元 |

### 14.4 Reviewer

| 场景 | 预期 |
|---|---|
| 纯项目介绍 | 不触发 Reviewer |
| 只修改一行文案 | 主智能体检查即可 |
| 3 个以上文件的行为修改 | 主验证后可触发 Reviewer |
| Reviewer BLOCKED 后修复 | 对原 Reviewer 使用一次 follow-up closure |

### 14.5 预算

- quick 到达 96 KiB 累计模型可见结果后停止读取并提交。
- normal 不得继承 exhaustive 的 64 轮统一上限。
- exhaustive 达到预算后返回 PARTIAL/低置信度也不能继续无限搜索。
- 单个 Agent 失败不得导致父智能体重复执行该 Agent 的全部调查。
- 父智能体最终答案不得直接拼接多个 10K 以上子报告。

## 15. 最终建议

CodeZ 不需要增加更多固定角色。当前最合理的目标是：

```text
主智能体：理解、决策、实现和综合
Explore：受预算和 Scope 强制的只读调查
Reviewer：实现完成后的独立验收
```

应优先借鉴：

1. Claude Code 的 `When NOT to use` 和 `Never delegate understanding`。
2. Codex 的显式多 Agent 委派开关和有限并发槽位思路。
3. Grok 的 Agent、Persona、Capability、Isolation 正交分层。
4. Grok 的最大深度 1 和 `resume_from`。
5. Claude Verification 的严格触发时机和结构化 verdict。
6. 三套系统共同体现的独立上下文、单一结果回传和父智能体最终负责原则。

本次异常首先应被视为委派控制面和预算控制问题，不应通过继续扩写 Explore 人格提示来掩盖。只有 Prompt 接线、运行时限制和工具 Scope 同时生效，才能稳定避免再次出现“一句简单请求产生数百万字符工具输出并撞上上下文上限”的情况。

## 16. 关键源码索引

### CodeZ

- `crates/codez-runtime/src/chat/prompt/modules/worker_delegation.rs`
- `crates/codez-runtime/src/chat/prompt/modules/task_management.rs`
- `crates/codez-runtime/src/agent/registry.rs`
- `crates/codez-runtime/src/agent/collaboration.rs`
- `crates/codez-runtime/src/tools/builtin/agent.rs`
- `src-tauri/src/chat_runtime.rs`
- `src/main/agent/definitions/ExploreSubAgent.ts`
- `src/main/agent/definitions/ReviewerSubAgent.ts`
- `src/main/agent/definitions/ExecutionPlannerSubAgent.ts`
- `src/main/agent/definitions/WorkerSubAgent.ts`

### Grok Build

- `crates/codegen/xai-grok-agent/templates/subagent_prompt.md`
- `crates/common/xai-tool-types/src/task.rs`
- `crates/codegen/xai-grok-agent/src/prompt/subagent_prompts.rs`
- `crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md`
- `crates/codegen/xai-grok-tools/src/implementations/grok_build/task/mod.rs`

### Claude Code

- `src/tools/AgentTool/prompt.ts`
- `src/tools/AgentTool/builtInAgents.ts`
- `src/tools/AgentTool/built-in/exploreAgent.ts`
- `src/tools/AgentTool/built-in/planAgent.ts`
- `src/tools/AgentTool/built-in/generalPurposeAgent.ts`
- `src/tools/AgentTool/built-in/verificationAgent.ts`
- `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts`
- `src/tools/AgentTool/built-in/statuslineSetup.ts`

### Codex rollout

- `C:\Users\asus\.codex\sessions\2026\07\16\rollout-2026-07-16T16-08-21-019f69f8-1394-71b3-a0e3-2821d2e79fcf.jsonl`
- `C:\Users\asus\.codex\sessions\2026\07\17\rollout-2026-07-17T14-36-19-019f6eca-384b-7c21-991c-31cd664493c7.jsonl`
- `C:\Users\asus\.codex\sessions\2026\07\17\rollout-2026-07-17T14-36-42-019f6eca-9f05-7b43-968a-7ecd742bf8a5.jsonl`
- `C:\Users\asus\.codex\sessions\2026\07\17\rollout-2026-07-17T14-37-09-019f6eca-ffdb-71f2-82d3-37fa11e53f57.jsonl`
