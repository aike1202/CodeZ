# Claude Code 主提示词装配图

## 最终选择优先级

`src/utils/systemPrompt.ts::buildEffectiveSystemPrompt` 决定最终 system 数组，优先级如下：

```text
overrideSystemPrompt
  -> coordinator prompt
  -> main-thread agent prompt
  -> --system-prompt custom prompt
  -> default getSystemPrompt()
  -> optional --append-system-prompt
```

细节：

- `overrideSystemPrompt` 出现时替换全部其他 prompt，连 append 也不追加。
- coordinator mode 替换默认主提示词，但仍追加 append prompt。
- main-thread custom agent 通常替换默认 prompt；proactive mode 下改为追加到默认 autonomous prompt。
- `--system-prompt` 替换默认 prompt。
- `--append-system-prompt` 在正常分支末尾追加。

## 默认 `getSystemPrompt()` 顺序

默认交互模式由 `src/constants/prompts.ts::getSystemPrompt` 生成 `string[]`：

```text
1. getSimpleIntroSection(outputStyleConfig)
2. getSimpleSystemSection()
3. getSimpleDoingTasksSection()       [可由 output style 关闭]
4. getActionsSection()
5. getUsingYourToolsSection(enabledTools)
6. getSimpleToneAndStyleSection()
7. getOutputEfficiencySection()
8. SYSTEM_PROMPT_DYNAMIC_BOUNDARY     [全局 cache scope 开启时]
9. session_guidance
10. memory
11. ant_model_override                [内部构建]
12. env_info_simple
13. language                          [设置存在时]
14. output_style                      [设置存在时]
15. mcp_instructions                  [未使用 delta 注入时]
16. scratchpad                        [启用时]
17. function-result-clearing          [feature/model 支持时]
18. summarize_tool_results
19. numeric_length_anchors             [内部构建]
20. token_budget                       [feature 开启时]
21. brief                              [Kairos/Brief 开启时]
```

静态/动态边界是缓存协议的一部分。API 发送前会跳过字面量 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`，但用它划分 cacheable prefix。

## 主要运行模式

### Simple

`CLAUDE_CODE_SIMPLE` 直接返回：

```text
You are Claude Code, Anthropic's official CLI for Claude.

CWD: {{ cwd }}
Date: {{ session_start_date }}
```

### Proactive/Kairos

启用且 active 时跳过常规静态提示词，改为：autonomous identity、安全规则、system reminders、memory、环境、语言、MCP、scratchpad、结果清理和 autonomous work。

### Coordinator

`CLAUDE_CODE_COORDINATOR_MODE` 使用专门的 coordinator system prompt，主 Agent 只负责任务分解、worker 调度与结果整合。

### Custom main-thread agent

指定 `--agent` 或 SDK agent 时，custom agent prompt 可替换默认主 prompt。此路径不能被误认为“Claude Code 默认主 Agent”。

## 动态 conversation 层

system prompt 之外，真实 transcript 还显示以下动态附件进入会话：

```text
user query
agent_listing_delta
skill_listing
command_permissions
loaded skill body (isMeta user message)
task_reminder
queued_command
CLAUDE.md / rules system-reminder
tool results
compaction summaries
```

`agent_listing_delta` 可把 Agent 目录从工具描述移到消息附件，避免 Agent/MCP/plugin/permission 变化反复破坏工具块缓存。

## Agent 工具决策规则

默认源码给主 Agent 的关键规则是：

- 使用 specialized agents 处理与 description 匹配的任务。
- 子 Agent 用于并行独立查询或隔离大量原始结果，但不要过度使用。
- 主 Agent 不应重复子 Agent 正在做的搜索。
- 定向搜索直接用 Glob/Grep。
- broader exploration 只有在简单搜索不足，或明确预计超过 `EXPLORE_AGENT_MIN_QUERIES = 3` 次查询时才使用 Explore。
- 用户明确要求并行时，在同一 assistant message 中发出多个 Agent tool-use block。

最后一条是“用户明确要求并行”的协议要求，不等于每个探索任务都应该一次性派发多个 Agent。

## 日志反推方法

Claude transcript 不保存隐藏 system prompt，因此完整请求采用以下合并：

```text
source-derived system prompt
+ source-derived tool schemas
+ transcript user/attachment sequence
+ transcript actual Agent tool input
+ child transcript actual first message and tool calls
+ response usage counters
```

日志中出现的 `input_tokens` 用于验证“确实还有大量隐藏输入”，但不能仅凭 token 总数逐字还原未知文本。

## 版本差异

真实日志版本 `2.1.197` 的 Explore description 明确禁止 code review、设计文档审计、跨文件一致性检查和开放式分析；当前恢复源码的 description 更宽泛。这类差异以日志为准记录在请求样例中，以源码为准记录当前模板，不进行无证据覆盖。

