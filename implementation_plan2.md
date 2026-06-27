# App.tsx 组件化拆分与重构计划

为了解决 `src/renderer/src/App.tsx` 文件过于庞大（约940行）的问题，并提升代码的可读性、可维护性与复用性，我们计划对 `App.tsx` 进行深度的组件化拆分，同时对重复的工具函数进行收敛。

## 主要变更设计

### 1. 抽取公共工具函数 `parseArgs`
- **当前问题**：`parseArgs` 作为一个流式不完整 JSON 参数解析器，分别在 `App.tsx`、`ToolCallLog.tsx` 和 `ExecutionLog.tsx` 中重复定义了三次，存在代码重复。
- **解决方案**：新建 [parseArgs.ts](file:///f:/MyProjectF/MyAgent/src/renderer/src/utils/parseArgs.ts)，将该解析器函数收敛并统一导出。

### 2. 增强 `FilePreviewPanel` 独立性
- **当前问题**：`FilePreviewPanel` 的流式预览状态（如 `renderedPreviewContent`、`activeToolCall`）和落盘后的自动 Reload 逻辑全都在 `App.tsx` 中计算和执行，导致 `App.tsx` 承载了太多预览层特有的状态。
- **解决方案**：
  - 将流式状态的计算和自动 Reload 逻辑移动到 `FilePreviewPanel.tsx` 内部。
  - `FilePreviewPanel` 改为接收 `previewContent` 和整个 `messages` 数组，在内部计算当前活跃的 toolCall 和渲染内容，并处理 reload 副作用。
  - `App.tsx` 中相关的 60 多行状态逻辑与 effect 被全部移除。

### 3. 新建 `ChatArea` 组件
- **当前问题**：`App.tsx` 包含整个消息历史的遍历渲染、极具逻辑深度的工具调用流式状态切片展示、消息重置/编辑的 `onDiffClick` 交互逻辑、以及智能触底滚动逻辑，这些占用了几百行的代码量。
- **解决方案**：
  - 新建 [ChatArea.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/chat/ChatArea.tsx) 组件。
  - 将 `App.tsx` 内部的 `containerRef`、触底滚动 `useEffect`、消息列表渲染（含 UserMessage / AgentMessage / ExecutionLog / MessageBody / EditApprovalWidget）、底部 `PromptArea` 包裹、以及 `TerminalPanel` 的挂载逻辑全部迁移至 `ChatArea.tsx`。

### 4. 极简化 `App.tsx`
- 经过上述抽取后，`App.tsx` 将只需保留顶层的 Sidebar、Workspace 状态、Provider 状态、全局聊天 Session 逻辑以及顶层的布局骨架。
- 预计将把 `App.tsx` 压缩至 500 行左右，使其成为清晰的顶层路由与控制层。

---

## 拟更改文件与模块

### [NEW] 新建公共工具函数
#### [NEW] [parseArgs.ts](file:///f:/MyProjectF/MyAgent/src/renderer/src/utils/parseArgs.ts)
- 迁移并统一导出 `parseArgs` 函数。

### [NEW] 新建 `ChatArea` 核心组件
#### [NEW] [ChatArea.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/chat/ChatArea.tsx)
- 承载完整的聊天消息流展示、触底滚动、终端面板包裹和输入区域。

### [MODIFY] 简化与重构组件
#### [MODIFY] [FilePreviewPanel.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/FilePreviewPanel.tsx)
- 引入 `parseArgs`，将流式参数解析和 reload 的 `useEffect` 逻辑收归本组件，简化 Props 传递。

#### [MODIFY] [App.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/App.tsx)
- 移出 `parseArgs`，移出预览计算与 Reload 副作用，移出消息列表及终端的 JSX，引入并使用 `<ChatArea>`。

#### [MODIFY] [ToolCallLog.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/chat/ToolCallLog.tsx)
- 移出局部 `parseArgs` 的定义，改为直接从 `../../utils/parseArgs` 引入。

#### [MODIFY] [ExecutionLog.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/chat/ExecutionLog.tsx)
- 移出局部 `parseArgs` 的定义，改为直接从 `../../utils/parseArgs` 引入。

---

## 验证计划

### 自动化验证
- 运行 `npm run typecheck` 确认 TypeScript 类型无报错。
- 运行 `npm run build` 确保项目顺利编译打包。

### 手动功能点验证
- 验证消息发送与 AI 流式回答（包括流式思考、工具调用过程日志的渲染）。
- 验证右侧文件预览面板在工具运行时的实时流式更新与工具结束后自动落盘无缝 Reload。
- 验证智能触底滚动在切换会话、新发消息以及 AI 输出时正常触发。
- 验证终端面板的打开、关闭与拉伸等操作没有 Regression。
