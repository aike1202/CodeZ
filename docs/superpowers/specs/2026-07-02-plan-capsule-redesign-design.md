# Plan 胶囊 (PlanCapsule) 重构设计文档

## 背景与目的
当前的 `PlanCapsule` 组件在用户体验和界面设计上存在以下几个缺陷：
1. **位置不合理**：它被放置在全局的 `TopBar` 中，这造成了视觉上的拥挤，且在逻辑上打破了层级关系（因为 Plan 是属于具体的聊天会话上下文的）。
2. **缺乏质感**：它的样式粗糙，不像一个真正的“胶囊”，缺乏高级感。
3. **内容针对性弱**：它目前仅显示整个大 Plan 的标题，而不是当前正在执行的具体任务步骤（Step），这让用户难以直观追踪实时进度。

本次重构旨在将 Plan 胶囊移至聊天上下文中，赋予其高级的亚克力（Glassmorphism）药丸形态，并将展示重点转移到**当前正在执行的任务步骤**上。

## 架构与位置
- **移出 TopBar**：将 `<PlanCapsule />` 从 `src/renderer/src/components/TopBar.tsx` 中彻底删除。
- **加入 ChatAreaLayout**：将 `<PlanCapsule />` 作为一个绝对定位（`position: absolute`）的悬浮层，放置在 `ChatArea` 容器的**右上角**。
- **层级关系（Z-Index）**：确保它悬浮在聊天消息流之上，但位于模态框（Modals）和下拉菜单之下。

## 组件与视觉设计

### 胶囊本体 (The Pill)
- **形态**：纯正的药丸形（`border-radius: 9999px`）。
- **材质**：亚克力毛玻璃效果（`backdrop-filter: blur(12px)`），背景使用半透明色，确保在明亮（Light）和暗黑（Dark）主题下均能完美融合。
- **边框与动画**：使用极细的边框。当 Agent 正在执行该步骤时，背景与边框会呈现一种极其优雅、缓慢的“流光呼吸”特效（Breathing Glow），替代之前生硬的边框闪烁。
- **内容排版**：
  - **左侧**：一个带有动画效果的 Lucide 图标（例如旋转的 `Loader2` 或闪烁的 `Sparkles`）表示“进行中”。
  - **中部文字**：**当前正在执行的步骤标题**（例如：`✨ P1: 登录界面设计`）。如果所有任务已完成，则显示“计划已完成”。
  - **右侧**：一个表示可展开的箭头图标（`ChevronDown` 或 `ChevronUp`）。

### 展开面板 (The Expanded Popover)
- **动画**：点击胶囊后，面板会从胶囊正下方平滑展开（带有渐隐淡入和向下滑移的 `transform/opacity` 过渡动画）。
- **头部 (Header)**：显示整个大 Plan 的主标题以及全局进度（例如：`2/5`）。
- **主体 (Body)**：垂直排列的所有任务步骤（Steps）。
- **图标升级**：彻底抛弃旧版的 Emoji，全面采用 Lucide React 线条图标（`CheckCircle2` 表示已完成，`Loader2` 表示进行中，`CircleDashed` 表示待执行）。
- **样式统一**：遵循应用整体的高级 CSS 变量。已完成的任务文本使用柔和的次要颜色，并带有删除线（Strikethrough）。

## 数据流向
- 组件依然订阅 `useChatStore`。
- 我们将动态计算出 `currentStep` 并在胶囊闭合时显示：
  ```typescript
  const currentStep = steps.find(s => s.status === 'in_progress') || steps.find(s => s.status === 'pending') || steps[steps.length - 1];
  ```
- 当胶囊未展开时，仅渲染 `currentStep` 相关元素，以节省空间并最小化视觉噪音。

## 错误处理与边缘情况
- 如果当前不存在 `activePlan`，或者其状态不是 `executing`，则整个胶囊隐藏（返回 `null`）。
- 如果 `subAgentStatus === 'running'` 但尚未产生具体的 Plan 实例，则显示一个“探索中... (Exploring...)”的独立胶囊。
- 文本过长时：使用省略号（`text-overflow: ellipsis`）和最大宽度限制，防止胶囊撑爆屏幕。
