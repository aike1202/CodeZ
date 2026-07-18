# Task、Skill 与 Deferred Tools

## Task

TaskStore 以 session 为作用域保存 typed snapshot。Create 一次可建 1-256 项，自动产生 `t1`、`t2` 等 ID 和 pending 状态。Update 按 taskId 做 partial update；Get/List 是只读。

Task effect：

```text
Create/Update -> MutateTaskState(session)
Get/List      -> ReadMemory(session tasks)
```

Create/Update 对同一 session 使用 ResourceLocked，避免并发丢更新。Prompt 的“at most one in_progress”是行为指导，store 也应维持版本化 snapshot；Task 工具不是工作执行器，只是 durable bookkeeping。

## Skill

```text
resolve requested exact name or ID from current bounded catalog
-> require enabled catalog item
-> read full trusted SKILL.md body
-> append [Skill Location] for supporting files
-> hash content
-> read latest session/context skill state
-> enforce disabled + force rule
-> append skill_state_updated ledger event
-> return full instructions as model-visible tool result
```

`Skill` 是兼容入口；`ActivateSkill` 才会清楚表达 persistent active state和 `force`。重复激活相同 args/content hash 返回 `already_active`，避免重复把大段 instructions 注入历史。

Deactivate：

- `inactive`：允许之后普通激活。
- `disabled`：必须有显式用户请求并用 `force=true` 才能恢复。

## Deferred exposure

Catalog 先把 exposure=Deferred 且尚未 activated 的 descriptor 放入 `deferred_tools`：

```text
NotebookEdit
PushNotification
WebFetch
WebSearch
```

ToolSearch 支持：

```text
select:WebFetch,WebSearch   exact multi-select
WebFetch                    exact name
mcp__docs                   MCP prefix match if such tools are in catalog
+documentation product      required/optional keyword scoring
```

匹配后将名称写入 `ToolExposureState` 的 `<session>:<contextScope>` key。激活只对下一 Provider turn 生效；同一批中紧接着调用 deferred tool 会得到 `TOOL_NOT_EXPOSED`。

## 当前 Prompt 漏洞

`ToolExecutionPipeline` 正确把 exposure plan 的 deferred summaries 传给 ToolSearch；但 `ChatPromptAssembler` 构建 PromptContext 时使用：

```rust
deferred_tools: Some(Vec::new())
```

因此 `<deferred_tools>` System 段永远空。模型只能看到 ToolSearch description，不知道具体有哪 4 个候选。修复应把本轮 `ToolExposurePlan.deferred_tools` 同时传给 prompt builder，不要另建一份目录。
