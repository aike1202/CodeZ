# 对话流与工具流混合排版 (Interleaved Rendering) 实现计划

## 目标与背景

当前，Agent 循环调用工具产生的思考内容和工具执行日志分别渲染，所有的回答（包含中间自我分析）都被拼接到同一个大块的 `MessageBody` 中，导致页面信息堆积，难以阅读。
我们的目标是重构渲染逻辑，将文本和工具执行记录按照**时间发生顺序（Timeline）**穿插渲染，提供类似于 Cursor 等优秀 IDE 的折叠式步骤体验。

## User Review Required

> [!IMPORTANT]
> 这是一个会对聊天核心展示结构产生重大修改的 UI 变更。
> 原本界面上的单独“折叠日志区”与“内容区”将被打散组合。请您确认以下拆解方式是否符合预期，确认后我再动手修改。

## Proposed Changes

### 1. 扩展状态管理 `chatStore.ts`
修改当前的聊天流状态存储，使得普通文字流也能作为时间线节点。

- **[MODIFY]** [chatStore.ts](file:///f:/MyProjectF/MyAgent/src/renderer/src/stores/chatStore.ts)
  - 新增 `TextTimelineItem` 类型，并将其加入 `ExecutionTimelineItem`。
  - 新增 `appendTextTimelineChunk` 逻辑。在每次大模型输出普通 `delta` (内容) 时，不只追加给全局的 `m.content`，还要追加进 `executionTimeline` 数组末尾最新的 `text` 节点。如果最后一个节点是工具调用，则新开一个 `text` 节点。

### 2. 重构前端主渲染流 `App.tsx`
改变过去的 `ExecutionLog` 叠在上面，`MessageBody` 放在下面的硬拼接模式。

- **[MODIFY]** [App.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/App.tsx)
  - 弃用单一的 `MessageBody` 渲染方式。
  - 在渲染 AI 消息时，遍历 `msg.executionTimeline`。
  - 根据 `item.type` 动态渲染组件：
    - 若遇到连续的 `text` 类型，使用 `MessageBody` 渲染该段文本。
    - 若遇到 `tool` 类型的节点，渲染一个紧凑的、带图标的工具调用卡片（或将连续的工具调用合并成一个可折叠组）。
  - （可选）保留全量 `msg.content` 的存储以供导出/历史备份，但界面渲染完全依赖 `executionTimeline` 的结构。

### 3. 工具执行组件 UI 调整 `ExecutionLog.tsx`
使组件支持局部穿插展示。

- **[MODIFY]** [ExecutionLog.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/chat/ExecutionLog.tsx)
  - 或者我们会将其拆分为更轻量的 `<ToolTimelineBlock />`。
  - 调整内外边距（Margin/Padding），确保文本段落 -> 折叠工具块 -> 文本段落的排版在视觉上连贯不突兀。

## Verification Plan
1. **启动测试**: 修改后启动项目，随意向 Agent 询问需要调用工具的任务（例如搜索某个词或读取文件）。
2. **视觉验证**: 验证 AI 回答的第一段思考文字在上面，随后紧跟折叠好的工具调用，最后在下面接着渲染总结文本。
3. **断言确认**: 避免在多次循环中重复渲染相同的字符串。
