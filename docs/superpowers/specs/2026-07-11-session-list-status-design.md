# 会话列表状态显示设计

## 背景

会话列表当前使用渲染进程的 `streamCleanups[sessionId]` 判断会话是否正在运行。
该对象本质上是流监听的清理句柄，不是运行状态的权威来源；切换会话、窗口重载或监听
清理后，它可能与主进程中仍在执行的 Runner 不一致。

需要用户处理的权限确认和问答请求已经随消息持久化，但尚未投影到会话列表。主聊天
错误目前只追加到消息正文，没有结构化终态，因此列表无法可靠区分普通文本和错误。

## 目标

- 后台会话运行时，切换到其他会话后列表仍准确显示“运行中”。
- 会话存在待处理权限确认或问答时，列表显示需要用户操作的提示。
- 最近一次执行错误时，列表显示错误状态。
- 应用启动、窗口重载和切换会话后，状态可从权威数据恢复。
- 复用现有 runtime 和消息请求字段，不引入互相冲突的持久状态源。

## 非目标

- 不实现跨主进程重启恢复正在执行的 Runner。
- 不恢复已失去 IPC responder 的历史确认请求。
- 不重新设计消息中的确认卡片或错误详情。
- 不引入轮询式会话状态同步。

## 统一列表状态

Sidebar 只接收一个互斥状态，而不是多个独立布尔值：

```ts
type SessionListStatus = 'action-required' | 'running' | 'error' | 'idle'
```

状态优先级为：

1. `action-required`
2. `running`
3. `error`
4. `idle`

待确认是用户可以立即解除的阻塞，应优先显示。运行中的新任务覆盖旧错误，避免历史错误
遮蔽当前进展。只有没有待处理请求且当前未运行时，最近错误才显示。

## 数据来源

### 运行状态

`ChatRuntimeRegistry` 继续作为主 Runner 是否活跃的权威来源，子智能体活跃集合继续由
`SubAgentManager` 提供。两者合成为现有 `SessionRuntimeStatus`：

```ts
interface SessionRuntimeStatus {
  sessionId: string
  mainRunnerActive: boolean
  activeSubAgentIds: string[]
}
```

主进程新增 runtime 状态变化事件。在主 Runner 注册、完成、失败、停止，以及子智能体
活跃集合变化时，向 renderer 推送受影响会话的最新快照。

renderer chat store 保存按 `sessionId` 索引的内存快照表。该表只反映当前主进程 runtime，
不写入会话持久化数据。应用加载会话列表后通过现有查询接口获取每个会话的快照，补齐
窗口初始化或监听建立前遗漏的事件；后续由事件实时更新。

`streamCleanups` 仍负责停止流和移除监听，但不再参与 Sidebar 状态判断。

### 待用户操作

`action-required` 从每个会话的消息中派生。只要任一消息包含以下项目，就视为待处理：

- `permissionRequests` 中 `status === 'pending'` 的请求。
- `askUserRequests` 中 `status === 'pending'` 的请求。

这些字段已经随会话消息持久化，新增和回答时也已有保存流程，因此不新增单独的
`hasPendingRequest` 持久字段。

如果应用重启后请求仍是 `pending`，但对应 runtime 已不存在，恢复逻辑应将其转换为
不可回答的中断或过期终态，不能继续把历史请求展示为可操作提示。具体终态沿用现有
中断语义，不创建新的等待 responder。

### 错误状态

消息增加结构化执行终态，至少支持标记主聊天流错误。错误回调同时保留现有可见错误
文本，并把对应 agent 消息标记为错误后持久化。Sidebar 从会话最后一次相关执行终态派生
`error`，不得解析消息正文。

发送新一轮消息时，旧错误不再作为列表当前状态；历史消息上的错误标记仍保留，用于
消息记录和调试。新一轮再次失败时，新的 agent 消息成为最近错误来源。

## 数据流

1. 应用加载会话列表并建立 runtime 事件监听。
2. renderer 为已加载会话查询 runtime 快照，按 `sessionId` 写入内存状态表。
3. 主 Runner 或子智能体状态变化时，主进程推送受影响会话的最新快照。
4. 消息中的确认请求新增、回答或过期时，现有消息更新触发 Sidebar 重新派生状态。
5. 流错误时，对应 agent 消息写入结构化错误终态并持久化。
6. `useAppWorkspace` 对每个会话按统一优先级计算 `SessionListStatus`。
7. `Sidebar -> ProjectItem -> SessionItem` 透传该状态并渲染对应图标、颜色和无障碍文本。

## 竞态与生命周期

- runtime 监听先建立，再执行初始快照查询；若查询响应晚于更新事件，store 使用状态版本
  或更新时间拒绝旧快照，避免回退。
- Runner 的正常完成、错误和用户停止都必须在 `finally` 路径注销 registry，并发布最终
  inactive 快照。
- 会话选择请求继续使用现有递增序号，拒绝过期的 session/runtime 查询结果。
- 删除会话时同步清理 renderer 中该 `sessionId` 的 runtime 快照。
- 主进程重启后 registry 为空，初始快照会把所有会话运行态恢复为 inactive。
- runtime 查询失败时保留最后一次事件状态，并记录诊断信息；不能用 `streamCleanups`
  猜测替代。

## UI 规则

- `action-required`：显示醒目的确认/问答图标，并提供“需要确认”的可访问名称。
- `running`：显示现有运行中动效，保持稳定尺寸，不引起列表布局位移。
- `error`：显示错误图标和错误色，提供“执行出错”的可访问名称。
- `idle`：保留普通会话图标。
- 状态图标不改变会话标题、菜单和删除交互，不新增嵌套卡片。

## 测试

新增或扩展测试覆盖：

1. 状态派生遵循 `action-required > running > error > idle`。
2. 权限确认与问答请求新增、回答后，列表状态立即更新。
3. Runner 注册、完成、错误和停止时发布正确的 session runtime 快照。
4. 初始快照能够恢复后台会话运行态，切换会话不会清除该状态。
5. 较旧的快照响应不能覆盖较新的 runtime 事件。
6. 主聊天错误写入结构化终态，普通消息正文不会误判为错误。
7. 新一轮运行覆盖旧错误，历史消息错误标记仍保留。
8. 删除会话会清理对应 runtime 状态。
9. 应用重启后没有 runtime 的历史 pending 请求不会继续显示为可回答。
10. Sidebar 四种状态的图标、文本和无障碍名称正确。

实现后运行相关单元测试，并按项目验证策略执行 `npm run test`、`npm run typecheck` 和
renderer 相关的 `npm run build`。

## 验收标准

- 会话 A 在后台运行时切换到会话 B，会话 A 列表项持续显示运行中；结束后自动恢复空闲。
- 后台会话出现权限确认或问答时，无需切回该会话即可在列表看到提示。
- 请求回答后提示消失，并根据实际 runtime 显示运行中或空闲。
- 流执行失败后列表显示错误；发送新的消息后旧错误不再遮蔽当前状态。
- 窗口重载或重新加载会话列表后，状态与主进程 runtime 和持久化消息一致。
