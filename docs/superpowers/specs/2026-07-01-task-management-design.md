# Task 管理工具设计文档

> 创建时间：2026-07-01
> 状态：approved
> 范围：src/main/tools/builtin/ + src/main/services/TaskStore.ts + src/renderer/src/components/chat/TaskPanel.tsx

## 1. 目标

为 CodeZ Agent 添加 4 个 Task 管理工具（TaskCreate / TaskGet / TaskList / TaskUpdate），支持 Agent 在多步任务中创建、追踪、更新子任务状态。前端以胶囊形式展示在 ChatArea 顶部，收缩态可折叠，展开显示完整任务列表。

## 2. 新增文件

```
src/main/tools/builtin/
├── TaskCreateTool.ts
├── TaskGetTool.ts
├── TaskListTool.ts
├── TaskUpdateTool.ts

src/renderer/src/components/chat/
├── TaskPanel.tsx
├── TaskPanel.css

src/tests/
├── task-create-tool.test.ts
├── task-update-tool.test.ts
├── task-store.test.ts
```

## 3. 修改文件

```
src/main/services/TaskStore.ts          ← 扩展数据模型 + 新增方法
src/main/tools/ToolManager.ts           ← 注册 4 个新工具
src/main/ipc/task.handlers.ts           ← 新增 TASK_UPSERT IPC 通道
src/shared/ipc/channels.ts              ← 新增 IPC 通道常量
src/renderer/src/stores/chatStore.ts    ← 新增 tasks / expandedCapsule 状态
src/renderer/src/components/chat/ChatAreaLayout.tsx ← 集成胶囊 + TaskPanel
```

## 4. 数据模型

### TaskData（扩展后）

```ts
interface TaskData {
  id: string                    // uuid
  sessionId: string             // 绑定会话
  subject: string               // 简短标题
  description: string           // 详细描述
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  blocks: string[]              // 被此任务阻塞的 taskId 列表
  blockedBy: string[]           // 阻塞此任务的 taskId 列表
  owner: string                 // agent 标识（默认 "main-agent"）
  createdAt: string
  updatedAt: string
}
```

### TaskStore 新增方法

```ts
class TaskStore {
  // 现有保留
  load(): Promise<void>
  getAllByProject(projectId: string): TaskData[]
  save(task: TaskData): Promise<void>
  delete(taskId: string): Promise<void>

  // 新增
  getBySession(sessionId: string): TaskData[]
  getById(taskId: string): TaskData | undefined
  updateStatus(taskId: string, status: TaskData['status']): Promise<void>
  addDependency(taskId: string, blockedByTaskId: string): Promise<void>
  removeDependency(taskId: string, blockedByTaskId: string): Promise<void>
}
```

## 5. 工具接口

### TaskCreateTool

| 属性 | 值 |
|------|-----|
| name | `TaskCreate` |
| input | `{ subject: string, description: string, blockedBy?: string[] }` |
| output | `{ ok: boolean, data: { taskId, subject, status: "pending" } }` |

行为：自动设置 status='pending', owner='main-agent', createdAt/updatedAt=now。blockedBy 非空时自动建立反向依赖。

### TaskGetTool

| 属性 | 值 |
|------|-----|
| name | `TaskGet` |
| input | `{ taskId: string }` |
| output | `{ ok: boolean, data: TaskData | { error: string } }` |

### TaskListTool

| 属性 | 值 |
|------|-----|
| name | `TaskList` |
| input | `{}`（自动取当前 sessionId） |
| output | `{ ok: boolean, data: { tasks: TaskData[], summary: string } }` |

summary 格式：`"2/5 completed, 1 in progress, 2 pending"`

### TaskUpdateTool

| 属性 | 值 |
|------|-----|
| name | `TaskUpdate` |
| input | `{ taskId: string, status?, subject?, description?, blocks?, blockedBy? }` |
| output | `{ ok: boolean, data: TaskData | { error: string } }` |

行为：DAG 校验（有未完成 blockedBy 时禁止 completed）；取消时自动解除 blocks；替换式更新 blocks/blockedBy 列表。

## 6. 前端 — 胶囊 + TaskPanel

### 胶囊（收缩态）

两个胶囊并排固定在 ChatArea 顶部（sticky, z-index: 10）：

```
┌─────────┐  ┌──────────────┐
│ 📋 Plan │  │ ✅ Tasks 2/5 │
└─────────┘  └──────────────┘
```

颜色语义：
- Plan 待审批：🟠 橙色
- Plan 执行中：🟢 绿色
- Task 有未完成：🔵 蓝色
- Task 全部完成：🟢 绿色
- 无活跃 Plan/Task：隐藏对应胶囊

### Task 胶囊（展开态）

```
┌──────────────────────────────────────────┐
│ ✅ Tasks 2/5              [▲ collapse]  │
│──────────────────────────────────────────│
│  🔄 2. 拆分 LoginForm                    │
│  ⬜ 3. 补单元测试                         │
│  🔒 4. 运行验证 (blocked by #3)          │
│  ✅ 1. 提取 useAuth hook                 │
│  ❌ 5. 代码审查 (cancelled)              │
└──────────────────────────────────────────┘
```

排序：in_progress → pending → blocked → completed → cancelled

### 互斥展开

两个胶囊只允许一个展开，由 `chatStore.expandedCapsule: 'plan' | 'task' | null` 控制。

### 数据流

```
Agent 调用 TaskCreate/TaskUpdate
  → Tool.execute() → TaskStore.save()
  → IPC 'task:upsert' → chatStore.upsertTask()
  → TaskPanel 实时更新
```

## 7. IPC 通道

```ts
// 共享常量
TASK_UPSERT: 'task:upsert',  // main → renderer，单条任务创建/更新
PLAN_STATE_CHANGED: 'plan:state-changed',  // main → renderer
PLAN_APPROVE: 'plan:approve',  // renderer → main
PLAN_REJECT: 'plan:reject',    // renderer → main
```

## 8. chatStore 扩展

```ts
// 新增状态
planState: 'idle' | 'active' | 'pending_approval' | 'executing'
planContent: string
expandedCapsule: 'plan' | 'task' | null
tasks: TaskData[]

// 新增方法
setPlanState(state, content?)
setExpandedCapsule(capsule: 'plan' | 'task' | null)
upsertTask(task: TaskData)
removeTask(taskId: string)
```

## 9. System Prompt 补充

在 `<developer_instructions>` 中的 Task 规则：

```
【TASK MANAGEMENT】
- Use TaskCreate to record steps before starting complex work.
- Use TaskUpdate to track progress (pending → in_progress → completed).
- Use TaskList to review what has been done and what remains.
- Only ONE task in_progress at a time.
- A task blocked by an unfinished task cannot start.
- If you cannot complete a task, cancel it with a clear reason.
```

## 10. 不涉及的范围

- 不新建 IPC handler 文件（扩展已有 task.handlers.ts）
- 不修改 AgentRunner（ToolManager 注册即可，工具结果如常注入消息循环）
- 不修改 Provider 层
- 不做 TaskOutput/TaskStop（需要后台异步执行模式支持）
