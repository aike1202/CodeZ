# Plan 自动关联：系统指令触发设计 (System Prompt Plan Association)

## 背景与目的
当前在使用“绑定开发计划”功能时，系统仅仅是在用户的输入框中填入了一段文案（`pendingPrompt`），需要用户手动点击发送才能让 Agent 知道绑定了 Plan。
为了提供更加连贯且智能的体验，我们重构这一流程：当用户绑定 Plan 后，在消息流中直接插入一条轻量化的、由“系统身份（System）”发出的提示信息，并立刻触发 AI 的响应，从而实现自动对接，省去用户多余的操作。

## 架构与数据模型
1. **角色扩展 (Role Expansion)**：
   - 修改 `ChatMessage` 接口，将 `role` 的类型从 `'user' | 'agent'` 扩展为 `'user' | 'agent' | 'system'`。
2. **状态管理 (State Management)**：
   - 在 `chatStore.ts` 中新增 `addSystemMessage(content: string)` 用于插入系统级消息。
   - `ChatSession` 持久化逻辑需要确保 `system` role 能够被正确序列化和反序列化。

## 组件与交互逻辑

### 1. `PlanListModal.tsx` 的改动
- 当用户选择 Plan 并成功绑定后：
  - 移除原有的 `useChatStore.getState().setPendingPrompt(...)`。
  - 调用新的系统发送事件，自动向当前对话插入系统指令。
  - 系统指令的内容示例：`💡 系统已加载开发计划：[计划名称]，请分析当前进度并告诉我下一步需要做什么。`

### 2. `useSendMessage.ts` 的改动
- 扩展原本只处理用户消息的逻辑，支持一键发送“System 消息”。
- 当触发系统消息时：
  1. 调用 `addSystemMessage(content)` 存入 UI 状态。
  2. 生成请求大模型的上下文，确保该系统消息转化为正确的发往后端的 `user` 角色（带隐藏标记）或者 `system` 角色。
  3. 执行常规的 `window.api.chat.stream` 等待 AI 的回复。

### 3. `ChatArea.tsx` 视觉呈现
- 遇到 `msg.role === 'system'` 时，跳过原有的 `user-message-bubble` 渲染逻辑。
- 提供专门的 System UI：
  - **位置**：居中对齐，类似于时间戳或系统通知的位置。
  - **样式**：采用灰色、小字号（例如 `text-sm text-gray-400` 或 `var(--text-muted)`），无边框或气泡背景，轻量不打扰。
  - **排版**：可以配合一个极其微小的图标（例如 Info 或 Sparkles）。

## 测试与边缘情况
- **空会话绑定**：如果用户在一个尚未建任何对话的主页触发绑定，必须确保能先 `createSession`，绑定 `activePlan`，再插入 System 消息并触发回复。
- **上下文裁剪兼容**：确保后端的上下文管理能够合理保留或处理 `system` role 的消息，不影响 Token 裁剪逻辑。
