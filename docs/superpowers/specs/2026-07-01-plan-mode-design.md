# Plan 模式设计文档

> 创建时间：2026-07-01
> 状态：approved
> 范围：src/main/agent/AgentRunner.ts + src/main/tools/ToolManager.ts + src/renderer/src/components/PromptArea.tsx

## 1. 目标

用户通过 PromptArea 旁的 Plan Toggle 按钮切换 Plan 模式。Plan 模式下 Agent 仅可使用只读工具探索和分析项目，不能修改文件或执行命令。用户审阅聊天中的分析结果后关闭 Plan 模式，Agent 恢复正常执行。

## 2. 与 Task 管理的关系

| Plan | Task |
|------|------|
| 用户控制（Toggle 按钮） | Agent 控制（工具调用） |
| 模式级（约束整个请求） | 任务级（追踪单步进度） |
| Plan 胶囊 🟠 | Task 胶囊 🔵 |
| Plan ON → Task 胶囊隐藏 | Plan OFF → Task 胶囊可见 |

## 3. 新增文件

```
src/tests/agent-runner-plan-mode.test.ts   ← AgentRunner planMode 行为测试
```

## 4. 修改文件

```
src/renderer/src/components/PromptArea.tsx     ← 添加 Plan Toggle 按钮
src/renderer/src/components/PromptArea.css     ← 按钮样式
src/renderer/src/components/chat/ChatAreaLayout.tsx ← Plan 胶囊集成
src/renderer/src/stores/chatStore.ts           ← planMode 状态
src/main/agent/AgentRunner.ts                  ← planMode 参数 + 只读约束
src/main/tools/ToolManager.ts                  ← getReadOnlyTools() 方法
src/main/ipc/chat.handlers.ts                  ← planMode 参数传递
src/shared/ipc/channels.ts                     ← PLAN_STATE_CHANGED 通道
```

## 5. 前端 — Plan Toggle 按钮

### 位置

PromptArea 输入框左侧：

```
┌─────────────────────────────────────────────┐
│  [● Plan]  │  Type your message...  │ [Send] │
└─────────────────────────────────────────────┘
```

### 状态

| 状态 | 外观 | 含义 |
|------|------|------|
| OFF（默认） | 灰色轮廓 `[○ Plan]` | 正常模式，全工具 |
| ON | 🟠 橙色填充 `[● Plan]` | Plan 模式，只读工具 |

### 行为

- 点击切换 ON/OFF，状态存 `chatStore.planMode: boolean`
- ON 时发送消息 → 请求携带 `planMode: true`
- 按钮 Tooltip: "Plan mode: read-only exploration and design"

## 6. 前端 — Plan 胶囊

### 收缩态

Plan 模式 ON 时显示在 ChatArea 顶部 sticky 位置，和 Task 胶囊互斥展示：

```
┌─────────┐
│ 📋 Plan │  🟠
└─────────┘
```

### 展开态 — Agent 推理中

```
┌──────────────────────────────────────────────┐
│ ▶ Plan mode — exploring      [▲ collapse]   │
│──────────────────────────────────────────────│
│  Read-only tools: Read · Glob · Grep         │
│  ListFiles · GetProjectSnapshot              │
│                                              │
│  Agent is analyzing the codebase...          │
│  The plan will appear in the chat below.     │
└──────────────────────────────────────────────┘
```

### 展开态 — Agent 回复完成

```
┌──────────────────────────────────────────────┐
│ ▶ Plan mode — awaiting review [▲ collapse]  │
│──────────────────────────────────────────────│
│  Read-only tools: Read · Glob · Grep         │
│  ListFiles · GetProjectSnapshot              │
│                                              │
│  Review the plan in the chat above.          │
│  Turn off [Plan] toggle to start executing.  │
│                                              │
│  Recent plan (detected from chat):           │
│  1. 提取 useAuth hook                        │
│  2. 拆分 LoginForm 为独立组件                │
│  3. 补单元测试                                │
└──────────────────────────────────────────────┘
```

"Recent plan" 检测逻辑：前端对 Agent 最近回复做简单正则匹配 `数字. 文本` 或 `- 文本` 模式提取步骤列表。检测不到则不显示此区域。

## 7. 后端 — AgentRunner 改造

### 请求扩展

```ts
interface AgentRunConfig {
  // ...existing
  planMode?: boolean
}
```

### 运行逻辑

```ts
// 工具选择
const availableTools = config.planMode
  ? this.toolManager.getReadOnlyTools()
  : (config.tools || this.toolManager.getToolDefinitions())

// Plan 模式引导
if (config.planMode) {
  allMessages.push({
    role: 'system',
    content: `You are in Plan Mode (read-only). Your goal:
1. Explore the codebase to understand relevant files and patterns.
2. Present a clear numbered plan for the implementation.
3. Do NOT make any edits, write files, or run commands.
When the user turns off Plan Mode, implement the approved plan.`
  })
}

// Plan 模式状态通知前端
mainWindow.webContents.send(IPC_CHANNELS.PLAN_STATE_CHANGED, {
  state: 'active',
  mode: config.planMode ? 'plan' : 'normal'
})
```

### ToolManager.getReadOnlyTools()

```ts
class ToolManager {
  private static READ_ONLY_TOOL_NAMES = new Set([
    'read_file',
    'list_files',
    'glob',
    'grep',
    'get_project_snapshot',
    'fast_context'
  ])

  getReadOnlyTools(): ToolDefinition[] {
    return this.getAllTools()
      .filter(t => ToolManager.READ_ONLY_TOOL_NAMES.has(t.name))
      .map(t => ({
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }
      }))
  }
}
```

## 8. System Prompt 补充

在 `<developer_instructions>` 中：

```
【PLAN MODE】
If a message arrives with planMode enabled:
- You are in read-only mode.
- Only use: read_file, list_files, glob, grep, get_project_snapshot, fast_context.
- Explore and present a numbered plan in the chat.
- Do NOT edit files, run commands, or call any other tool.
- Wait for the user to turn off Plan Mode before implementing.
```

## 9. IPC 通道

```ts
PLAN_STATE_CHANGED: 'plan:state-changed'
// main → renderer: { state: 'active' | 'idle', mode: 'plan' | 'normal' }
```

## 10. 不涉及的范围

- 不新建 EnterPlanMode/ExitPlanMode Tool（用户通过 Toggle 按钮控制）
- 不新增 IPC handler 文件
- 不修改 Provider 层
- Plan 不持久化——页面刷新后恢复为 OFF
