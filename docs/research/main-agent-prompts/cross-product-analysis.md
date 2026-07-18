# Claude Code、Codex、Grok Build、CodeZ 主 Agent 架构对比

CodeZ 的分阶段实现顺序、验收不变量与评测集见 [codez-optimization-blueprint.md](codez-optimization-blueprint.md)。

## 结论

四个平台的核心差异不在“谁的 system prompt 更长”，而在于上下文如何分层、如何缓存、以及动态目录何时进入模型上下文。

| 维度 | Claude Code | Codex | Grok Build | CodeZ |
|---|---|---|---|---|
| 静态主提示词 | TypeScript 函数分段生成 | rollout 的 `base_instructions` | MiniJinja `prompt.md` 模板 | Rust PromptPipeline 模块 |
| 动态层 | session guidance、memory、环境、MCP、语言、输出风格 | developer 消息、权限、应用上下文、模式、skills/plugins、AGENTS.md、环境 | 模板占位符、工具种类、首条 user prefix、规则、skills、MCP | context、rules、env、Git、skills、tools、task gates |
| 项目规则 | `CLAUDE.md`/rules 以 context/reminder 进入 | `AGENTS.md` 作为 developer/user 层进入 | `AGENTS.md`/CLAUDE/rules 进入首条 user context | global/workspace rules 进入 System |
| 子 Agent 目录 | `agent_listing_delta` 动态附件或工具描述 | 内置 `default`/`worker`/`explorer` 与自定义 agents | `task` 工具描述中的 built-in descriptors | Rust registry 有 Explore/Reviewer，但目录模块关闭 |
| 真实日志可见度 | transcript 可见动态附件和调用，不含隐藏 system 原文 | rollout 可见 base instructions 与各角色层 | 本次仅有源码，无同版本本机真实会话 | Ledger 有完整消息/调用/usage，无 outbound System/tools |
| 缓存设计 | 静态/动态边界与 section cache | 运行时按消息层和上下文窗口管理 | 模板渲染后作为 system，环境与规则多放首条 user message | 每轮重建 Prompt，ledger/compaction/result handle 控制历史 |

## 工具内核对比

| 工具面 | Claude Code | Codex | Grok Build | CodeZ |
|---|---|---|---|---|
| Read | 专用多媒体工具；25K tokens/256 KiB；`readFileState` 去重和先读证明 | 当前主要经 shell/Get-Content；无本地内部源码 | 专用多媒体工具；默认 1,000 行、25K tokens、负 offset、流式投影 | 多文件、5000 行、10MiB、UTF-8、Read fingerprint |
| Edit | 精确替换；强制先 Read、mtime 校验、写前二次竞态检查 | `apply_patch`；真实 diff 可审计，内部算法未暴露 | 精确替换；Unicode fallback；先 Read 主要是提示，没有同等 mtime/CAS | ordered exact replacements + fingerprint + backup transaction |
| Grep | ripgrep；三种模式、默认 250、分页和大结果持久化 | 通过 `rg` shell command 和输出预算 | ripgrep；默认 200/500、limit+1、5 MB cap、提前 kill child | bundled ripgrep、三种模式、5000 cap、offset、result handle |
| Glob/List | 默认 100，按 mtime 排序、cwd 内相对化 | `rg --files` 等 shell 命令 | 10K 字符预算，depth-1 seed + BFS 展开 + subtree 摘要 | Glob 5000；list_files 32 dirs/2000 entries，不跟 link |
| Shell | AST/legacy 双解析、规则/路径/重定向/sandbox 多层权限 | `exec` 结构化编排 `exec_command`；权限依赖宿主 shell classifier | persistent terminal、结构化 background、timeout/process-group、流式通知 | shell parser/effects/receipt；retained task；trusted UTF-8 injection |
| SubAgent | Agent 目录、sync/async/team、mailbox/output file | spawn/mailbox/follow-up，独立 rollout，共享 filesystem | task/query/kill/resume，capability 与 isolation 正交，最大深度 1 | Durable Agent/mailbox/followup；Explore/Reviewer allowlist；8 active attempts |

详细 schema、执行算法和证据边界见各平台 `tools/`，主子交互协议见 `subagent-io-and-interaction.md`。

## Task 与计划状态对比

| 维度 | Claude Code | Codex | Grok Build | CodeZ 方案 |
|---|---|---|---|---|
| 当前工作状态 | Durable Task/Todo，Task 支持依赖 | `update_plan` 表示当前协作状态 | `todo` 保存/替换 session 清单 | Session-scoped durable snapshot |
| 依赖 | `blocks`/`blockedBy` | plan step 顺序，无通用依赖图 | todo 清单为主 | 只持久化 `blockedBy`，反向 `blocks` 派生 |
| 并发保护 | 运行时 Task 状态更新 | 最多一个 `in_progress` | merge/replace session 清单 | session mutex + 多 `in_progress` + 所有写入 `expectedRevision` CAS |
| 准入 | 提示和工具状态共同约束 | plan 是协作状态，不执行工作 | todo 与 subagent 分离 | 未完成依赖/待审批禁止开始或完成 |
| 与 Agent 的关系 | Task 是进度数据，Agent 是计算实例 | plan/thread/Agent/Goal 分离 | todo/Goal/task 子智能体分离 | Task 永不自动 spawn Agent |

CodeZ 采用三者交集而不是复制任一 schema：保留批量 Create、revisioned atomic persistence、风险/审批/验收/验证字段；吸收 Claude 的依赖图和最新状态读取约束、Codex 的协作状态边界与 replan explanation、Grok 的并行执行表达和简短状态摘要。没有采用双向依赖持久化、Task 自动分配 Agent，或丢失状态后的宽松 merge fallback。

## 最值得借鉴的设计

### 1. 把“策略”和“目录”分开

Claude Code 的 `agent_listing_delta`、Codex 的 agent profile、Grok 的 `SubagentDescriptor` 都说明：主提示词只应该定义何时委派和委派约束，具体可用 Agent 列表应作为可变目录注入。这样新增 Agent 不需要重写核心人格与安全策略。

### 2. 给 Explore 设置明确升级阈值

Claude Code 当前源码给出非常具体的门槛：简单定向搜索直接使用 Glob/Grep；只有搜索预计超过约 3 次查询，或简单搜索已经不足时，才升级到 Explore。这个规则比“复杂任务就用 Explore”可靠得多。

CodeZ 应采用可执行的门控条件：

- 已知文件、类、函数、错误文本：主 Agent 直接搜索。
- 未知入口但只需 1 到 3 次检索：主 Agent 直接搜索。
- 跨模块调用链、多个命名变体、需要隔离大量原始输出：最多派发 1 个 Explore。
- 只有存在互不重叠的研究轴时才并行派发多个 Agent，禁止为同一问题一次性固定派发 4 个 Explore。

### 3. 动态上下文必须有预算

Claude 的真实子 Agent 日志显示，Explore 首轮即有 19,420 input tokens；载入一个大技能后，多次并行工具调用对应的请求可达到 134,661 input tokens 加 18,944 cache-read tokens。上下文成本不仅来自父任务描述，还来自 system prompt、工具 schema、skill listing、完整 skill body、项目规则和历史工具结果。

建议给 CodeZ 增加逐层预算指标：

```text
base_prompt_tokens
tool_schema_tokens
project_rules_tokens
skill_catalog_tokens
loaded_skill_tokens
conversation_tokens
tool_result_tokens
delegation_brief_tokens
```

超过预算时应先压缩或减少目录，而不是继续派 Agent 扩大输入。

### 4. 请求日志要保存“装配结果”和“来源图”

仅保存聊天 transcript 无法复盘模型实际收到的全部输入。推荐同时持久化：

```json
{
  "request_id": "...",
  "model": "...",
  "messages": [],
  "tools": [],
  "resolved_prompt_layers": [],
  "layer_hashes": [],
  "token_breakdown": {},
  "parent_agent_id": null,
  "agent_type": "main",
  "feature_flags": {}
}
```

敏感层可以只保存加密内容和可审计 hash，但不能只记录最终 token 总数。

### 5. 子 Agent 必须返回摘要，不返回原始洪流

Codex 当前公开手册明确建议让子 Agent 返回总结；Claude 的默认子 Agent prompt 也要求以简洁报告交回调用者；Grok 的 built-in prompt 要求详细但聚焦的 writeup。CodeZ 的问题不是“能否并发”，而是缺少输出预算、停止条件和父 Agent 的合并约束。

## 对 CodeZ 的直接建议

1. 默认并发预算设为 1，只有主 Agent 输出非重叠任务分解后才能提升。
2. Explore 每次调用必须包含 `scope`、`question`、`max_tool_calls`、`max_output_chars`、`stop_when`。
3. 同一归一化问题在一个 turn 内只允许一个活跃 Explore；后续补充使用 resume/steer，而不是新建。
4. 主 Agent 收到子 Agent 结果后只保留摘要和证据索引，原始输出放外置 artifact。
5. 日志 UI 展示“逻辑 Task 数”和“实际 Agent 实例数”两个计数，避免把 Task 记录误认为 Agent 数。
6. PowerShell 授权分类器只接收业务命令；编码初始化由受信运行时完成，避免当前日志中的 `shellunparsed` 误判。
7. 让 WorkerDelegation gate 识别实际的 `spawn_agent`，并从唯一 Agent registry 渲染 when-to-use/when-not-to-use。
8. 把 ToolExposurePlan 的 deferred summaries 传给 PromptContext，避免 ToolSearch 目录在 System 中消失。
9. 将 Registry 的 maxLoops/outputSpec 接到当前 Rust Agent executor，否则目录声明只是 UI 元数据。

## 版本差异提醒

本机较旧 Codex rollout 的开发者层写明总并发槽位为 4；2026-07-18 拉取的公开 Codex 手册写明 `agents.max_threads` 默认值为 6、`agents.max_depth` 默认值为 1。它们属于不同运行时版本或宿主配置，不能互相覆盖。
