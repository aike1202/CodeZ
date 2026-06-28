# 10 Swarm 多 Agent 并发路线图

## 1. 用户需求

用户希望项目最终能发展成多 Agent 并发 Coding 系统，提高复杂任务处理效率：

- Manager 拆任务。
- Scout 并行探索文件。
- Coder 并行实现独立模块。
- QA 接棒验证。
- Blackboard 共享关键上下文。
- UI 展示多轨道进度。

## 2. 当前项目依据

来源设计：

- `docs/SWARM_ARCHITECTURE_PLAN.md`

当前项目基础：

- `src/main/agent/AgentRunner.ts` 可作为子 Agent 运行载体。
- `src/main/tools/ToolManager.ts` 可扩展按角色过滤工具。
- `src/main/agent/ContextManager.ts` 可接入黑板上下文。
- `src/main/ipc/chat.handlers.ts` 可扩展 swarm IPC。

## 3. 为什么 Swarm 不是第一轮

Swarm 会放大以下问题：

- 工具选择混乱。
- 文件写入冲突。
- 权限不完整。
- Diff / rollback 不完整。
- 验证闭环不稳定。
- 上下文注入不稳定。

因此必须先完成阶段 1-7。

## 4. 最终目的

形成多 Agent 调度系统：

```text
User
→ Manager Agent
→ Task DAG
→ SwarmDispatcher
→ Scout / Coder / QA Agents
→ AgentBlackboard
→ Merge / Verify
→ Final Report
```

## 5. 角色需求

| 角色 | 职责 | 工具权限 |
| --- | --- | --- |
| Manager | 需求理解、任务拆解、DAG、结果合并 | search/read only，不写文件 |
| Scout | 快速搜索、读取、总结上下文 | search/read only |
| Coder | 修改授权范围内文件 | search/read/apply_patch，有限 shell |
| QA | 运行测试、验证、诊断失败 | read/shell，默认不写；必要时可建议修复 |

## 6. 核心模块

### 6.1 RoleConfig

```ts
type AgentRole = 'manager' | 'scout' | 'coder' | 'qa'

type RoleConfig = {
  role: AgentRole
  label: string
  systemPrompt: string
  allowedTools: string[]
  fileScope: FileScopeRule[]
  maxParallelism: number
  priority: number
}
```

### 6.2 SwarmDispatcher

职责：

- 接收 DAG。
- 拓扑排序。
- 控制并发。
- 启动 AgentRunner。
- 收集结果。
- 处理失败、超时、重试。
- 检测文件冲突。

### 6.3 AgentBlackboard

职责：

- 保存 API 契约。
- 保存关键发现。
- 保存文件责任边界。
- 给后续 Agent 注入摘要。

## 7. 实施顺序

必须等阶段 1-7 完成后再开始。

1. `RoleConfig` 类型定义。
2. `ToolManager.filterByRole()`。
3. `AgentRunner` 支持 roleConfig 注入。
4. `AgentBlackboard` 内存实现。
5. `SwarmDispatcher` 顺序执行多个任务。
6. DAG 校验。
7. 并发执行。
8. 文件 scope 冲突检测。
9. QA 自动验证。
10. 多轨道 UI。

## 8. 验证方式

### 8.1 单元验证

- Manager 不能调用写文件工具。
- Scout 不能调用 shell。
- Coder 只能写 fileScope 内文件。
- QA 默认不能写文件。
- DAG 有环时校验失败。
- Blackboard TTL 能过期清理。

### 8.2 集成验证

构造任务：

```text
扫描工具系统，分别总结搜索工具和写入工具，然后由 Manager 合并报告。
```

期望：

- 两个 Scout 并行读取不同文件。
- Blackboard 记录结果。
- Manager 合并。
- 没有文件修改。

再构造任务：

```text
为一个小工具补测试并运行验证。
```

期望：

- Coder 写测试。
- QA 运行测试。
- Manager 汇总。

### 8.3 命令验证

- `npm test`
- `npm run typecheck`
- Swarm 相关集成测试。

## 9. 完成标准

- 多 Agent 并发不是简单 Promise.all，而是有角色、权限、DAG、黑板和冲突控制。
- 任一子 Agent 失败不会破坏全局任务。
- 用户能在 UI 看到每个 Agent 的进度。
- 文件写入冲突被检测并阻止。
- Manager / Scout / Coder / QA 都能读取同一份 GoalSnapshot、DecisionLog、TaskPlan 和 VerificationLedger，避免压缩或并发导致目标漂移。
