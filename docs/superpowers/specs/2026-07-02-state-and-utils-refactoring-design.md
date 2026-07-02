# 状态管理与工具库重构设计方案 (State & Utilities Refactoring Design)

## 1. 重构背景与目标

当前 `src/renderer/src/stores/chatStore.ts` (814 行) 和 `src/renderer/src/components/chat/ExecutionLogUtils.ts` (497 行) 属于项目中体量最大的状态管理与工具库文件。

为了提升代码可读性、可维护性与测试便利性，同时遵循项目规范（单文件行数推荐在 150 行以内，上限 200 行），本项目计划对状态层与工具层进行模块化拆分。

### 核心设计原则
1. **零破坏性升级**：对外导出的 Hook 和工具函数 API 保持 100% 兼容，使用方的 import 路径无需修改。
2. **单一职责原则 (SRP)**：按领域切分 Slice 和工具模块，每个子文件代码行数控制在 150 行以内。
3. **Zustand Slice Pattern 规范**：使用 Zustand 官方 Slice 范式，保持全局 State 访问一致性。

---

## 2. 详细拆分架构设计

### 2.1 Zustand `chatStore` 拆分 (`src/renderer/src/stores/chatStore/`)

将原 814 行的 `chatStore.ts` 改造为目录结构：

```text
src/renderer/src/stores/chatStore/
├── index.ts                  # 主入口，组合各 Slice 并导出 `useChatStore` 钩子
├── types.ts                  # 集中声明 ChatMessage, ToolCallState, ChatSession 等接口
└── slices/
    ├── sessionSlice.ts       # 会话管理逻辑 (createSession, selectSession, archiveSession, deleteSession 等)
    ├── messageSlice.ts       # 消息流与 IPC 监听 (addMessage, appendThinking, initPlanStateListener 等)
    └── approvalSlice.ts      # 用户授权与提问审批 (resolvePermissionRequest, resolveAskUserRequest 等)
```

#### 各子切片职责说明：

* **`types.ts`**:
  * 定义 `AgentState`, `ToolCallState`, `ExecutionTimelineItem`, `ChatMessage`, `PermissionRequestState`, `AskUserRequestState`, `ChatSession` 等状态结构体。
  * 定义各个 Slice 接口定义：`SessionSlice`, `MessageSlice`, `ApprovalSlice`，以及三者合一的 `ChatStoreState`。

* **`slices/sessionSlice.ts`**:
  * 专职负责 Sessions 列表的加载、创建、选择、删除、归档与恢复操作。

* **`slices/messageSlice.ts`**:
  * 专职负责消息追加、思考内容流式拼接、Agent 状态与工具调用更新，以及 Electron IPC `chat:plan-state-changed` 监听的回调绑定。

* **`slices/approvalSlice.ts`**:
  * 专职负责 `permissionRequests` 与 `askUserRequests` 的状态改变与用户回调响应处理。

* **`index.ts`**:
  * 使用 `create<ChatStoreState>()((...a) => ({ ...createSessionSlice(...a), ...createMessageSlice(...a), ...createApprovalSlice(...a) }))` 模式组合导出的统一 Hook。

---

### 2.2 `ExecutionLogUtils` 拆分 (`src/renderer/src/components/chat/ExecutionLog/utils/`)

将原 497 行的 `ExecutionLogUtils.ts` 移动并提炼至 `ExecutionLog/utils/` 目录：

```text
src/renderer/src/components/chat/ExecutionLog/utils/
├── index.ts                  # Re-export 所有工具方法，保持接口平滑兼容
├── types.ts                  # 统一时间线 UnifiedTimelineItem 等数据类型定义
├── timelineBuilder.ts        # buildUnifiedTimeline, buildFallbackTimeline 组合核心逻辑
├── itemParsers.ts            # buildCommandItems, buildEditItems 提取逻辑
├── summaryFormatter.ts       # buildSummaryText 文本格式化
└── iconMapper.tsx            # getFileIconComponent 文件图标组件选择器
```

---

## 3. 验证与测试计划

1. **类型检查**：使用 `npx tsc --noEmit` 确保无任何 TypeScript 类型报错。
2. **回归验证**：验证会话切换、消息发送、思维链显示、权限审批框弹出的完整功能。
