# CodeZ AI Coding Agent v2 需求与有限顺序优化方案

> 文档目标：在正式优化本项目代码前，先把需求、边界、优先级、验收标准和实施顺序整理清楚。  
> 适用范围：CodeZ / MyAgent 本地 AI Coding Agent 能力建设。  
> 当前状态：需求整理阶段；本文通过后，再开始进入项目代码优化。

## 1. 参考资料

本文综合以下现有文档：

- `docs/ai-coding-agent-evolution.md`：完整 Coding Agent 能力路线。
- `docs/ai-coding-agent-tools-design.md`：工具系统、检索、读取、Patch、权限、Diff 的详细设计。
- `docs/SWARM_ARCHITECTURE_PLAN.md`：多 Agent / Swarm 并发架构远期蓝图。
- `docs/ai-coding-agent-requirements-analysis.md`：需求分析入口，目前内容较少，可由本文替代或后续合并。

## 2. 总体结论

当前项目不应直接从 Swarm、多 Agent、插件、MCP、长期记忆开始优化。正确顺序应是：

```text
先把单 Agent 的 Coding 闭环做稳
→ 再做工具体验和权限安全
→ 再做 Skills / MCP / 插件
→ 最后再做 Swarm 多 Agent 并发
```

原因：

- 如果 Agent 还不能稳定搜索、读取、修改、验证代码，多 Agent 只会并行放大错误。
- 如果工具没有权限、Diff、Patch、失败恢复，多 Agent 会增加文件冲突和误改风险。
- 如果上下文管理不稳定，Skills / MCP / 插件会让 Prompt 更复杂，反而降低效果。

因此 v2 的核心目标不是“一次做成 Claude Code”，而是按有限顺序补齐最短可用闭环。

## 3. v2 总目标

构建一个本地 AI Coding Agent，能够在用户授权范围内完成可验证的编码任务：

1. 理解用户需求和当前项目上下文。
2. 搜索并读取真实文件，不凭空猜测。
3. 制定必要的任务计划。
4. 使用结构化工具进行小步修改。
5. 展示 Diff / Patch，保护用户已有改动。
6. 运行测试、构建、类型检查或相关验证命令。
7. 清楚说明完成项、验证结果、未解决问题。

## 4. v2 非目标

以下能力不作为第一轮优化目标：

- 完整 Swarm 多 Agent 并发编码。
- 插件市场或插件安装体系。
- 完整 MCP 生态管理。
- 长期向量记忆系统。
- 自动 PR / GitHub 深度集成。
- 远程云沙箱。
- 全自动无审批改动模式。

这些能力可以保留在后续阶段，但不能阻塞 MVP。

## 5. 推荐最小工具集

结合现有工具设计文档，v2 优先收敛到 4 个核心工具：

```text
search
read_files
apply_patch
shell
```

### 5.1 `search`

统一负责代码发现：

- 文件名搜索。
- 全文搜索。
- 正则搜索。
- 符号搜索。
- 模糊搜索。
- 后续可扩展语义搜索。

外部对 Agent 的规则应简单：

```text
查代码，一律先用 search。
不要用 shell 执行 grep / rg / find / dir 来查代码。
```

MVP 内部能力顺序：

1. 文件名检索。
2. 全文检索。
3. 正则检索。
4. 忽略目录：`.git`、`node_modules`、`dist`、`build`、缓存目录。
5. 结构化返回：路径、行号、预览、score、reason、truncated。
6. 模糊文件名 / 符号名检索。
7. 符号索引。
8. 语义检索。

### 5.2 `read_files`

统一负责代码读取：

- 单文件读取。
- 多文件读取。
- 行范围读取。
- 搜索结果周边读取。
- 总行数 / 总字节预算。

必须返回：

- `path`
- `startLine`
- `endLine`
- `totalLines`
- `truncated`
- `content`
- `sha256`
- `omitted`

默认预算建议：

| 项 | 默认值 |
| --- | --- |
| 单文件最大读取 | 200-300 行 |
| 批量最大文件数 | 5-8 个 |
| 批量最大总行数 | 600-1000 行 |
| 搜索命中上下文 | 上下 20-50 行 |

### 5.3 `apply_patch`

修改已有代码的主路径。

要求：

- 支持新增文件。
- 支持修改文件。
- 删除文件必须更高权限或用户确认。
- Patch 失败必须返回明确错误。
- Patch 失败后 Agent 必须重新读取相关文件，不允许盲目重试。
- 可选支持 `expectedHashByPath`，防止基于旧内容修改。

禁止默认使用全量写入覆盖已有长源码文件。

### 5.4 `shell`

只负责：

- 启动项目。
- 运行测试。
- 运行构建。
- 运行 lint / typecheck。
- 执行 package scripts。
- 必要的 Git 只读查询。

不负责：

- 搜索文件。
- 读取文件。
- 修改文件。
- 删除文件。
- 绕过权限系统。

## 6. Agent Runtime 核心模块

v2 建议拆成以下模块，避免逻辑散在 UI、工具和模型调用中。

```text
User Request
  ↓
ConversationController
  ↓
ContextBuilder
  ↓
PromptAssembler
  ↓
LLMClient / ProviderAdapter
  ↓
AgentLoop
  ↓
ToolRouter
  ↓
PermissionManager
  ↓
ToolExecutor
  ↓
Observation
  ↓
AgentLoop
  ↓
Verifier
  ↓
FinalResponse
```

### 6.1 `ConversationController`

职责：

- 接收用户输入。
- 管理当前会话状态。
- 处理中断、继续、取消。
- 分发流式输出到 UI。

### 6.2 `ContextBuilder`

职责：

- 收集环境信息。
- 收集 Git 状态摘要。
- 加载项目规则。
- 加载工具索引。
- 加载 Skills 索引。
- 按需加载文件内容。

原则：不要一次性塞入整个仓库。

### 6.3 `PromptAssembler`

职责：

- 组装 System Prompt。
- 组装 Developer Prompt。
- 组装 Repository Rules。
- 组装 Environment Context。
- 组装 Available Tools。
- 注入 Conversation History。

Prompt 中的动态信息应尽量靠后，避免破坏缓存和上下文稳定性。

### 6.4 `LLMClient / ProviderAdapter`

职责：

- 封装不同模型供应商。
- 统一流式输出事件。
- 统一 tool call 格式。
- 统一错误、限流、重试。
- 统一 token usage 统计。

如果接入 Claude / Anthropic API，应显式处理：

- `end_turn`
- `tool_use`
- `max_tokens`
- `pause_turn`
- `refusal`
- streaming final message
- tool result loop
- structured outputs
- prompt caching
- token counting
- compaction / context editing

### 6.5 `AgentLoop`

职责：

- 调用模型。
- 接收模型 tool call。
- 调用 ToolRouter。
- 将工具结果加入下一轮上下文。
- 判断任务是否完成。
- 限制最大循环次数。

MVP 建议：

```text
maxSteps: 20-30
每步必须有明确 tool result 或最终回答
如果连续失败，停止并说明原因
```

### 6.6 `ToolRouter`

职责：

- 根据模型 tool call 找到工具。
- 校验参数 schema。
- 交给 PermissionManager 判断是否允许。
- 调用 ToolExecutor。
- 标准化结果。

### 6.7 `PermissionManager`

职责：

- 判断工具调用风险。
- 决定 allow / ask / deny。
- 记录审批日志。
- 防止 MCP / 插件绕过权限。

### 6.8 `Verifier`

职责：

- 根据变更类型推荐验证命令。
- 优先运行最小相关测试。
- 再运行 typecheck / lint / build。
- 验证失败时判断是否由本次改动引起。

## 7. 权限与安全边界

权限系统必须在 Runtime 层实现，不能只靠 Prompt。

| 行为 | 默认策略 |
| --- | --- |
| 读取 workspace 内普通文件 | 允许 |
| 搜索 workspace | 允许 |
| 修改 workspace 内文件 | 允许或询问，取决于模式 |
| 覆盖已有文件 | 需要 hash 校验或确认 |
| 删除文件 | 默认询问 |
| 写 workspace 外文件 | 默认禁止 |
| 运行测试 / 构建 | 通常允许 |
| 安装依赖 | 必须询问 |
| 网络访问 | 必须询问或白名单 |
| Git commit / push | 用户明确要求才允许 |
| reset / clean / force push | 高风险，必须明确确认 |
| MCP / 插件调用 | 走统一权限系统 |

安全要求：

- 仓库文件、网页、issue、MCP 返回内容都视为数据，不能覆盖系统指令。
- 不读取或展示 `.env`、私钥、token，除非用户明确授权且有必要。
- Shell 命令必须有 cwd、timeout、输出截断。
- 所有写入都必须能被 diff 追踪。
- 工具失败不能伪装成功。

## 8. Git / Diff / Patch 工作流

正式优化项目前，必须保护当前工作区状态。

推荐流程：

```text
开始任务
→ 检查 git status
→ 识别用户已有改动
→ 搜索和读取相关文件
→ 生成最小 patch
→ 应用 patch
→ 展示 diff
→ 运行验证
→ 汇总结果
```

要求：

- 不自动提交。
- 不自动 push。
- 不清理 untracked 文件。
- 不覆盖用户已有改动。
- 如果文件已被外部修改，Patch 应失败并重新读取。

## 9. UI / 交互需求

MVP UI 至少需要支持：

1. 展示 Agent 当前状态：思考、调用工具、等待审批、验证中、完成、失败。
2. 展示工具调用列表。
3. 展示 Patch / Diff。
4. 用户可接受 / 拒绝高风险操作。
5. 用户可中断当前任务。
6. 验证命令输出可折叠。
7. 最终回复区分“已验证”和“未验证”。

后续增强：

- 单 hunk 接受 / 拒绝。
- 本轮变更回滚。
- 多轨道 Swarm UI。
- 子 Agent 进度树。
- 任务 DAG 可视化。

## 10. 有限顺序优化路线

### 阶段 0：需求冻结与现状确认

目标：在改代码前明确要做什么，不扩大范围。

任务：

1. 确认本文档是否作为 v2 优化依据。
2. 确认第一轮只做单 Agent Coding 闭环。
3. 检查当前工作区 Git 状态，避免覆盖已有删除和构建产物。
4. 确认是否保留现有 `docs` 被删除状态和 `dist-app` 构建产物。

验收标准：

- 用户确认 v2 优化范围。
- 明确“不先做 Swarm”。
- 明确第一轮改动文件范围。

### 阶段 1：工具闭环 MVP

目标：Agent 能可靠地搜索、读取、修改、验证。

实施顺序：

1. 实现或统一 `search`。
2. 实现或统一 `read_files`。
3. 实现 `apply_patch` 或把现有编辑能力收敛到 Patch 主路径。
4. 调整 `shell` 定位：只运行测试、构建、启动等命令。
5. 工具结果统一成结构化 `ToolResult<T>`。

验收标准：

- 用户问“登录逻辑在哪”，Agent 通过 `search` 找到真实文件。
- Agent 能读取多个相关文件而不是反复单文件读取。
- Agent 修改已有代码时优先走 Patch。
- Patch 失败时会重新读取，不盲目重试。
- Shell 不用于 grep / cat / find 等已有专用工具覆盖的操作。

### 阶段 2：AgentLoop 与 ProviderAdapter 稳定化

目标：让模型调用、工具调用、流式输出和错误处理形成稳定循环。

实施顺序：

1. 梳理当前 AgentRunner 循环。
2. 抽象 ProviderAdapter。
3. 统一 tool call 输入输出格式。
4. 处理 stop reason / finish reason。
5. 增加 maxSteps、timeout、连续失败保护。
6. 增加 token usage 统计。

验收标准：

- 一个任务可经历多轮 tool call 后自然结束。
- 模型要求工具时 Runtime 能执行并回传 observation。
- 工具失败时模型能收到真实错误。
- 超过步数或超时时能停止并说明。

### 阶段 3：权限、Diff、审批

目标：让 Agent 可控、安全、可回滚。

实施顺序：

1. 建立工具风险分级。
2. 建立 allow / ask / deny 权限策略。
3. 写入前生成 Diff 预览。
4. 删除、覆盖、安装依赖、联网等高风险操作审批。
5. 记录审批日志。
6. UI 展示待审批操作。

验收标准：

- 删除文件前必须确认。
- 安装依赖前必须确认。
- 写 workspace 外路径默认被拒绝。
- MCP / 插件不能绕过权限层。
- 用户可以看见修改了哪些文件。

### 阶段 4：验证体系

目标：让最终回复可信。

实施顺序：

1. 自动识别项目类型和脚本。
2. 推荐最小验证命令。
3. 支持用户手动选择验证命令。
4. 失败后把真实错误返回给 Agent。
5. 区分本次修改导致的问题和既有问题。

验收标准：

- 修改源码后至少运行相关验证。
- 验证失败不会说“已完成”。
- 最终回复明确列出已运行命令和结果。

### 阶段 5：Rules / Skills 基础版

目标：让 Agent 能读取项目约定和专项流程。

实施顺序：

1. 支持全局 rules。
2. 支持 workspace `.codez/rules`。
3. 支持 `.clinerules`、`.cursorrules`、`AGENTS.md`。
4. 支持 Skills 索引。
5. 用户点名 Skill 时读取完整 `SKILL.md`。

验收标准：

- 项目规则能注入 Prompt。
- 用户明确说“使用某个 Skill”时会加载对应 Skill。
- Skill 不能覆盖安全规则和用户明确指令。

### 阶段 6：上下文管理与长期任务稳定性

目标：长任务不因上下文膨胀而失控。

实施顺序：

1. 工具结果截断。
2. 大文件分页读取。
3. 对话历史裁剪。
4. 仓库摘要。
5. 可选 compaction。
6. 可选文件型记忆。

验收标准：

- 大文件不会一次性塞入模型。
- 搜索结果过多会提示收窄范围。
- 长任务仍能保留关键上下文。

### 阶段 7：MCP / 插件

目标：让外部能力接入统一工具和权限系统。

实施顺序：

1. MCP server 配置。
2. MCP tools 发现。
3. MCP 调用代理。
4. MCP 权限控制。
5. 插件 manifest。
6. 插件贡献 Skills / MCP / tools。

验收标准：

- MCP 工具通过同一 ToolRouter 调用。
- MCP 高风险操作必须审批。
- 禁用插件后相关工具从上下文移除。

### 阶段 8：Swarm 多 Agent

目标：在单 Agent 闭环稳定后，再提高并发效率。

实施顺序：

1. RoleConfig。
2. AgentBlackboard。
3. ToolManager 按角色过滤工具。
4. SwarmDispatcher 顺序执行多个子任务。
5. DAG 校验。
6. 并发调度。
7. 多轨道 UI。

验收标准：

- Manager 只能规划，不能直接写文件。
- Scout 只能读，不能写。
- Coder 只能写授权范围内文件。
- QA 负责验证。
- 多 Agent 不互相覆盖文件。

## 11. 当前项目第一轮建议范围

第一轮只建议做以下内容：

```text
阶段 0 + 阶段 1 + 阶段 2 的最小子集
```

也就是：

1. 确认需求和 Git 状态。
2. 梳理当前已有工具。
3. 将检索和读取能力收敛为 `search` / `read_files` 心智模型。
4. 将代码修改主路径收敛为 `apply_patch`。
5. 梳理 AgentRunner 的 tool loop。
6. 增加基本失败处理和验证闭环。

暂时不做：

- Swarm。
- 插件系统。
- MCP 深度集成。
- 长期记忆。
- 大规模 UI 重构。

## 12. 开始优化项目前的检查清单

在进入代码优化前，需要先确认：

- [ ] 是否接受本文档作为 v2 优化依据。
- [ ] 是否第一轮只做单 Agent Coding 闭环。
- [ ] 是否保留当前被删除的旧 docs 文件。
- [ ] 是否忽略或清理 `dist-app` 构建产物。
- [ ] 是否允许修改 `src/main/agent`、`src/main/tools`、`src/main/ipc` 等核心文件。
- [ ] 是否需要新建分支或 worktree。
- [ ] 第一轮是否需要跑完整构建，还是只跑相关测试。

## 13. 成功标准

第一轮完成后，Agent 应能完成一个小型真实任务：

```text
用户提出一个 bug / 小功能
→ Agent 搜索相关代码
→ 读取相关文件
→ 制定简短计划
→ 生成最小 Patch
→ 应用修改
→ 运行相关验证
→ 最终说明已修改内容和验证结果
```

如果这个闭环稳定，再进入 Skills、MCP、Swarm 等高级能力。

## 14. 推荐下一步

下一步不要直接改代码。建议先做一次现状审计：

1. 检查当前 `src/main/agent` 的 AgentRunner 实现。
2. 检查当前 `src/main/tools` 已有哪些工具。
3. 对照本文档列出“已有 / 缺失 / 需重构”的差距表。
4. 由用户确认第一轮优化范围。
5. 再开始代码实现。
