# Todo / Plan 分层协作设计文档

> 创建时间：2026-07-05
> 状态：drafting
> 范围：src/main/tools/builtin/TodoWriteTool.ts + src/renderer/src/components/chat/TodoCapsule.tsx + system prompt
> 关联：[[2026-07-01-task-management-design]]（本文件是其简化 + 定位修正版）

## 1. 背景与问题

CodeZ 当前只有**重型 Plan**（PlanStore + PlanSubAgent + 用户审批 + 跨会话 `.md` 持久化），
没有轻量的"任务清单"。导致：

- 任何"值得列几步"的中等任务，模型要么什么都不记（用户看不到进度），
  要么被迫走重型 Plan（弹确认框、启动 SubAgent，太重）。
- 名字混淆：现有 `TaskTool.ts` 实际是 **subagent 调度器**，与"待办清单"无关。

**决策**（已与用户确认）：
- **分层并存**：直接做 / 轻量 Todo / 重型 Plan 三层，按改动规模选择。
- **Todo 仅会话内存**：不落磁盘，随会话走；持久化是 Plan 的职责。
- **不移除 Plan**：保留其 SubAgent 探索 + 用户审批 + 跨会话持久化的价值。

## 2. 三层模型

```
用户请求
   │
   ├─ 简单（1-2 文件 / 改法明确）        → 直接做，不记任何东西
   │
   ├─ 中等（>2-3 步，值得追踪进度）      → TodoWrite（轻量，会话内存）
   │                                      模型自主写清单、打勾推进，不打断用户
   │
   └─ 重大（架构决策 / 多方案 / 影响面大）→ EnterPlanMode（重型）
                                          SubAgent 探索 + 用户审批 + 落盘持久化
```

### 职责边界（核心）

| 维度 | Todo | Plan |
|------|------|------|
| 回答的问题 | "做到哪了"（执行追踪） | "该做什么"（规划 + 对齐） |
| 触发 | 模型自主，无需用户批准 | 模型建议 → 用户审批 |
| 生成方式 | 模型直接写 | Plan SubAgent 探索代码后生成 |
| 持久化 | 会话内存（随会话） | 磁盘 `.md`（跨会话） |
| 生命周期 | 本次对话 | 跨会话，有状态机 |

### 两者的配合点

**Plan 审批通过后，其 P0/P1 步骤可灌入 Todo 列表执行。**
即：Plan 定"做什么" → 转成一组 Todo → 执行阶段只看 Todo 打勾。
这样两层不重叠：Plan 退居"规划/对齐"，Todo 专注"执行追踪"。

> 本期范围：先落地独立的 Todo 能力。Plan→Todo 自动灌入作为后续增强，
> 本期仅在 system prompt 里说明"Plan 执行阶段可用 Todo 追踪"，不做自动转换代码。

## 3. 相对 07-01 设计的简化（明确砍掉）

| 07-01 设计 | 本期决定 | 理由 |
|-----------|---------|------|
| DAG 依赖（blocks/blockedBy） | ❌ 砍掉 | 过度设计。顺序靠列表次序 + "同时只 1 个 in_progress" |
| TaskStore 落磁盘 | ❌ 砍掉 | Todo 仅会话内存，持久化是 Plan 职责 |
| 4 个工具（Create/Get/List/Update） | ⭐ 合并为 1 个 `TodoWrite` | 一次性重写整个清单，无状态累积，模型心智更简单 |
| 命名 `Task` | ⭐ 改名 `TodoWrite` | 避免与现有 subagent 调度器 `TaskTool` 冲突 |

## 4. 数据模型

```ts
// src/shared/types/todo.ts（新增）
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  /** 稳定 id（模型给的短标识，用于跨轮次匹配；也可用 index 兜底） */
  id: string
  /** 简短内容 */
  content: string
  status: TodoStatus
}
```

无 owner、无依赖、无时间戳、无 sessionId 字段——sessionId 由 IPC 上下文携带，不进数据体。

## 5. 工具接口：TodoWrite

单一工具，**全量重写**语义（与业界 TodoWrite 一致）：

| 属性 | 值 |
|------|-----|
| name | `TodoWrite` |
| input | `{ todos: TodoItem[] }` |
| output | `{ ok: true, data: { total, completed, inProgress } }` |

行为：
- 每次调用用传入的 `todos` **整体替换**当前会话的清单（不做增量 merge）。
- 校验：最多 1 个 `in_progress`（多于 1 个则返回 `ok:false` 提示，不写入）。
- 执行后通过 IPC `TODO_UPDATED` 广播给渲染进程。

新增文件：
```
src/shared/types/todo.ts
src/main/tools/builtin/TodoWriteTool.ts
src/renderer/src/components/chat/TodoCapsule.tsx
src/renderer/src/components/chat/TodoCapsule.css
src/tests/todo-write-tool.test.ts
```

修改文件：
```
src/main/tools/ToolManager.ts          ← 注册 TodoWriteTool
src/shared/ipc/channels.ts             ← 新增 TODO_UPDATED 通道
src/renderer/src/stores/chatStore.ts   ← 新增 todos 状态 + setTodos
src/renderer/src/components/chat/ChatAreaLayout.tsx ← 挂 TodoCapsule（PlanCapsule 旁）
src/main/services/prompts/sections/DeveloperInstructions.ts ← 三层选择规则
```

## 6. 会话内存存储

不新建 Store 类。在 AgentRunner 拦截 `TodoWrite` 时，把清单存进
**当前 session 的内存字段**（如 `session.todos`），随会话生命周期存活，
会话结束即释放。渲染进程侧存 `chatStore.todos`，由 IPC 同步。

> 与 Plan 对比：Plan 走 PlanStore 落盘；Todo 完全不碰磁盘。

## 7. 前端 UI：TodoCapsule

复用现有 `PlanCapsule` 的胶囊 + popover 交互模式（见 PlanCapsule.tsx），
挂在 ChatAreaLayout 顶部、Plan 胶囊旁边：

```
┌──────────────┐  ┌───────────────┐
│ 📋 Plan p1.. │  │ ✅ Todo 2/5   │
└──────────────┘  └───────────────┘
```

- 收缩态：显示 `✅ Todo {completed}/{total}` + 当前 in_progress 项标题。
- 展开态 popover：清单列表，图标区分 pending / in_progress(转圈) / completed。
- 无活跃 todo（列表空）时隐藏整个胶囊。
- 排序：in_progress → pending → completed。
- 遵循 UDF：胶囊只读 `chatStore.todos`，不写；无独立本地可变状态（除展开开关）。

## 8. IPC 通道

```ts
// src/shared/ipc/channels.ts 新增
TODO_UPDATED: 'todo:updated',  // main → renderer，全量清单
```

数据流：
```
Agent 调用 TodoWrite
  → AgentRunner 拦截 → 写入 session.todos（内存）
  → IPC 'todo:updated' → chatStore.setTodos()
  → TodoCapsule 重渲染
```

## 9. System Prompt 补充

在 `<developer_instructions>` 新增三层选择规则（替代当前只讲 Plan 的表述）：

```
【WORK TRACKING — choose the right level】
- Simple (1-2 files, obvious approach): just do it. Do NOT create todos or a plan.
- Multi-step (more than 2-3 steps worth tracking): call TodoWrite to record the
  steps, then update it as you go. This is lightweight — do it WITHOUT asking the user.
- Major (architectural decisions, multiple valid approaches, large blast radius):
  suggest EnterPlanMode. A Plan SubAgent explores and produces a reviewed plan.

【TODO RULES】
- TodoWrite replaces the whole list each call (not incremental).
- Keep at most ONE item in_progress at a time.
- Mark an item completed as soon as it is done, before starting the next.
- When a Plan is executing, you may use TodoWrite to track its steps' progress.
```

## 10. 不涉及的范围

- 不修改 Plan / PlanStore / PlanSubAgent 现有行为。
- 不做 Plan→Todo 自动灌入（后续增强，本期仅 prompt 层说明）。
- 不做 Todo 落盘 / 跨会话恢复。
- 不做 Todo 依赖图 / 优先级 / 指派。
- 不重命名或删除现有 `TaskTool.ts`（它是 subagent 调度器，与本设计无关）。
```

## 11. 验收标准

- 模型对"做一个待办网页应用"这类多步任务，会自动调用 TodoWrite 列出步骤并逐步打勾，全程不打断用户。
- 对"改个错别字"这类简单任务，不产生任何 Todo。
- Todo 胶囊在 ChatArea 顶部实时反映进度；会话切换后清单随会话隔离。
- Plan 现有行为完全不受影响。
