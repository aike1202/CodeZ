# Session-Scoped Plans (会话级开发计划隔离) 设计文档

## 核心目标
当前的 Plan（开发计划）设计为绑定在全局 Workspace，这导致如果用户在新的聊天会话中讨论与项目主线无关的边缘问题（如查语法、写小脚本）时，全局高亮的 Plan 进度和 Agent 被强制注入的 Plan 上下文会造成严重的逻辑冲突。
本设计将 Plan 的激活层级从“工作空间全局（Workspace）”降级隔离到“会话局部（Session）”，使用户能够在一个项目中同时维持多条任务线，或者拥有无计划束缚的干净沙盒会话。

## 架构改造 (Data & Architecture)

### 1. 会话模型扩展 (Chat Session Model)
- **后端**：在 `ChatSession` 实体数据中新增可选字段 `linkedPlanSlug?: string`。
- **前端**：在 `chatStore` 的 `sessions` 列表中，同步增加 `linkedPlanSlug`，用于追踪当前会话绑定的计划。

### 2. 状态推导 (State Derivation)
- **前端 `activePlan` 派生**：全局的 `activePlan` 不再是由 `PlanStore.getActive()` 决定。当用户切换会话（`selectSession`）时，系统读取当前 `activeSession.linkedPlanSlug`，并通过 `window.api.plan.load(slug)` 加载具体的计划数据到前端的 `activePlan` 状态。
- **后端 Prompt 注入**：`AgentRunner` 在处理对话时，不再粗暴地加载全局 `executing` 的 Plan，而是去读取该对话所对应的 `Session`，如果发现有 `linkedPlanSlug`，再将其作为附加上下文注入到 System Prompt 中。

## UI 交互设计 (User Experience)

### 1. 「+」 按钮绑定入口 (Attachment Menu)
- **位置**：聊天输入框（PromptArea）左侧或下方的 `+` 按钮。
- **功能**：点击展开菜单，新增一项功能 “📋 绑定开发计划 (Load Plan)”。
- **流程**：
  1. 点击后弹出 `PlanListModal`（开发计划列表面板）。
  2. 面板内默认过滤或醒目展示“尚未完成的 Plan”。
  3. 用户点击某一项 Plan，触发绑定逻辑，当前会话更新 `linkedPlanSlug`，右上角的亚克力胶囊（PlanCapsule）随之浮现。

### 2. 快捷指令入口 (Slash Command)
- **指令**：在聊天输入框内键入 `/plans`。
- **功能**：触发拦截逻辑，不发送给 AI，而是直接呼出 `PlanListModal`，实现键盘流的快速绑定。

### 3. 解绑机制 (Unbind)
- 如果当前会话已经绑定了 Plan，可以在 PlanCapsule 的下拉面板中，或者 `+` 菜单中提供一个「解绑」或「挂起」的选项，将当前会话的 `linkedPlanSlug` 置空，使其恢复为纯净的对话沙盒。

## 边缘场景与约束
1. **多会话并发**：允许「会话 A」和「会话 B」同时绑定同一个 Plan。当 Plan 状态在后端发生变更时（如进度推进），通过 IPC 广播，A 和 B 的前端胶囊状态都会同步更新。
2. **计划悬挂 (Orphan Plans)**：如果一个 Plan 创建后没有任何会话绑定它，它默认存在于 `.agents/plans` 中处于休眠状态，等待用户通过 `/plans` 去认领它。
