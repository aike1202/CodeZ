# Todo、Skill 与 Deferred Tools

## Todo

Todo 是 session 级 durable collaboration state，只描述工作，不拥有 Agent 或 Executor 生命周期。现有 `tasks/` 持久化目录与 Electron `SessionData.tasks` 字段作为历史数据兼容层保留；模型和新桌面契约统一使用 Todo 命名。

模型工具面只有：

```text
TodoCreate { expectedRevision, idempotencyKey?, items[] }
TodoUpdate { expectedRevision, reason?, updates[] }
TodoArchive { expectedRevision, todoIds[], reason }
```

Todo 写工具在同一 session mutex 内执行完整事务：

1. 检查必填 revision、空 batch、重复 todoId 和 Create 幂等收据。
2. 克隆权威 snapshot，并在副本上应用全部 patch。
3. 校验状态转换、取消/重开/依赖/批量范围变更的 reason、clearFields、最终依赖图、审批门、未完成依赖和验证证据；允许多个真实并行的 `in_progress`。
4. 全部通过后只增加一次 revision、持久化一次、发送一次事件。
5. 冲突时返回最新有界 Todo state，模型无需也不能调用 Get/List。

`blockedBy` 是唯一持久依赖方向；`blocks`、ready/blocked 和 unfinished dependencies 都从 snapshot 派生。内部 `todo_list`/`todo_get` IPC 仅供 UI、恢复和故障处理。

每个 Provider round 都从同一 Store 重新生成：

```text
<todo_state revision="N">
summary + bounded active item details + compact item list + nextAction
</todo_state>
```

`nextAction` 基于结构化状态而不是标题匹配：优先继续真实 `in_progress`、启动 ready 项或报告 blocker；最后一个完成项关闭后若没有 passed `verificationEvidence`，返回 `verify_before_final`，供长期恢复和最终答复前对账。

投影限制项目数量和字段长度，并 JSON 编码 Todo 文本。工具结果历史不是 Todo 权威来源。

Executor 暂时停用模型入口：`DelegateTasks`、`ExecutionInspect`、`ExecutionControl` 不进入工具目录；TodoStore 不订阅 ExecutionController，AgentRunner 也不通过 Todo 恢复执行状态。Executor 实现保留，等待后续独立升级。

## Skill

`Skill` 是兼容入口；`ActivateSkill` 表达 persistent active state 和 `force`。激活流程解析当前 bounded catalog、读取完整可信 `SKILL.md`、记录内容 hash 与 session/context state。重复激活相同内容返回 `already_active`。

Deactivate 状态：

- `inactive`：允许之后普通激活。
- `disabled`：必须有显式用户请求并用 `force=true` 才能恢复。

## Deferred exposure

Deferred descriptors 由当前 exposure plan 传给 ToolSearch。激活写入 `<session>:<contextScope>`，只对下一 Provider round 生效；同一批紧接调用仍返回 `TOOL_NOT_EXPOSED`。

当前工作树仍有一个独立问题：`ChatPromptAssembler` 把 deferred summaries 设为空，且 Provider tool surface 在循环外缓存，导致 ToolSearch 激活与下一轮 schema/prompt 不一致。它不属于 Todo 改造，应在 capability snapshot slice 中单独修复。
