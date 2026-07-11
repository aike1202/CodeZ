# CodeZ 上下文 Token 稳定性修复设计

## 问题证据

会话 `1783702614137_javz7l` 的活动历史估算为 170,385 tokens，其中一条 `Glob` 结果包含 621,396 个字符，单条占 157,679 tokens。Provider 侧记录显示主请求约 295k 输入，Compaction 请求约 6.3k 输入；Compaction 连续 13 次因 `version must be 1` 或 `goal must be an object` 失败。

因此问题不是正常的长会话增长，而是三项缺陷叠加：最近尾部保护绕过了单条输出上限、`Glob` 无结果数量限制、Compaction 缺少可修复 Schema 提示和失败熔断。

## 目标

- 单条成功工具结果不得因位于最近协议尾部而无限进入模型请求。
- `Glob` 默认最多展示 1,000 条结果，并明确报告总数和缩小查询范围的方法。
- 原始 UI 工具结果和持久化账本保持完整；限制只作用于模型可见副本和工具自身的返回边界。
- Compaction 首次 Schema 失败后允许一次定向修复；再次失败时为当前 Agent run 打开熔断器。
- UI 主值显示本轮模型请求用量；详情同时显示原始持久化历史估算。
- Provider usage 到达后，以 Provider 输入 token 更新本轮主值，并明确标记数据来源。

## 非目标

- 不引入 tokenizer 依赖。
- 不删除或重写现有账本事件。
- 不改变 Session UI 历史。
- 不为所有工具增加分页协议；本次只修复已确认失控的 `Glob`，并用全局模型副本上限兜底其他工具。

## 设计

### 工具输出边界

`GlobTool` 增加可选 `head_limit`，默认 1,000，范围 1 到 5,000。返回值超过限制时只输出前 N 条，并追加稳定提示：实际匹配总数、当前展示数，以及使用更窄 `pattern`/`path` 的建议。

`ToolOutputPruner` 分两阶段运行：

1. 紧急单条清理：所有成功、非 `Skill`、非错误的工具结果，只要超过 `min(8,000, usableInputBudget * 10%)` tokens，即使位于保护尾部也替换为包含 head、tail、原长度、token 估算和 SHA-256 的占位对象。
2. 旧历史清理：在保护尾部之前按现有目标预算继续从最大结果开始清理。

协议消息本身不删除，assistant tool call 与 tool result 配对保持不变。

### Compaction 稳定性

Compaction 输入在发送给摘要模型前同样执行紧急单条清理，避免摘要请求携带数十万 token 的目录列表。

摘要提示加入完整 JSON 骨架和字段类型。首次校验失败时，将精简后的校验错误和上一份无效输出回传给模型，只允许一次修复调用。第二次失败时记录一个 `compaction_failed`，并在当前 `CompactionService` 实例中打开非重试熔断器；同一 Agent run 的后续自动压缩直接返回该失败，不再调用 Provider。新用户 turn 或手动 `/compact` 会创建新实例，可以重新尝试。

### 预算与 UI

`ContextBudgetSnapshot` 增加：

- `rawHistoryTokens`：账本活动历史未清理前的启发式估算。
- `providerAdjustmentTokens`：Provider 实际输入与分类启发式合计的差额，可为负数。

`recentHistoryTokens` 保持为本轮实际模型可见历史。请求前先展示启发式估算；Provider usage 到达后，用 `inputTokens` 校准 `totalInputTokens`、压力等级和数据来源。ContextTracker 主圆环始终表示本轮请求，明细单独显示原始持久化历史，避免把“可恢复数据量”和“本次发送量”混为一谈。

## 错误处理

- `Glob` 限制不是错误，返回成功结果和截断提示。
- 紧急工具清理不修改源消息或账本。
- Compaction 修复失败后不继续请求风暴，UI 保留最后一次明确错误。
- 若清理后仍超过硬输入限制，继续使用现有 `BUDGET_UNAVAILABLE` 拒绝逻辑。

## 验收

- 621,396 字符的最新 `Glob` 结果即使在保护尾部，本轮模型可见历史也低于动态单条上限加正常历史。
- 1,500 个 Glob 匹配默认只返回 1,000 条并报告 `1,500` 总数。
- 第一次无效、第二次有效的摘要可以完成 Compaction。
- 连续两次无效摘要后，同一服务实例的再次 `compact()` 不增加模型调用次数。
- Provider usage 可以把启发式预算更新为实际输入 token；UI 同时展示本轮值和原始历史值。
- 全量测试、类型检查和生产构建通过。

