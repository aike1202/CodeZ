# 聊天区自动滚动 vs 用户操作 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在聊天主滚动区实现"严格跟随"自动滚动——用户在底部时跟随,向上滚则暂停并提供"回到最新"按钮恢复,程序自动滚动不误判。

**Architecture:** 在 `ChatArea/index.tsx` 内联 `isFollowing` 局部状态 + `isProgrammaticScroll` ref,通过 `onScroll` 监听用户滚动并切换跟随态,通过改造现有 `useEffect` 决定何时自动滚到底。按钮用 `createPortal` 渲染进滚动容器。`ChatAreaLayout` 加一个 `onScroll` 透传 prop。

**Tech Stack:** React 18 + TypeScript + Zustand,Electron renderer。CSS 变量主题(`--bg-panel`/`--border-color`/`--text-main`/`--primary-color`,支持暗黑模式)。

## Global Constraints

- 不改 `ExecutionLog` 的展开/折叠逻辑(保持现状)
- 不改 `TerminalPanel`(xterm 有自己的滚动)
- `isFollowing` 是 `ChatArea` 局部 state,不下传给子组件
- 不写单元/组件测试,仅手动验收
- 比例阈值:`SCROLL_BOTTOM_RATIO = 0.15`,`SCROLL_BOTTOM_MIN_PX = 100`
- 按钮文案:"↓ 回到最新"

---

## 文件结构

| 文件 | 责任 | 操作 |
|---|---|---|
| `src/renderer/src/components/chat/ChatArea/index.tsx` | 跟随状态、滚动判定、自动滚动触发、按钮渲染 | MODIFY |
| `src/renderer/src/components/chat/ChatAreaLayout.tsx` | 透传 `onScroll` 到滚动容器 | MODIFY |
| `src/renderer/src/App.css` | `.scroll-to-bottom-btn` 按钮样式 | MODIFY |

---

### Task 1: ChatAreaLayout 透传 onScroll prop

**Files:**
- Modify: `src/renderer/src/components/chat/ChatAreaLayout.tsx`

**Interfaces:**
- Produces: `ChatAreaLayoutProps` 新增可选 `onScroll?: (e: React.UIEvent<HTMLDivElement>) => void`,透传到 `<Stack onScroll={onScroll}>`

**说明:** 这一步独立先行,因为后续 ChatArea 要用到这个 prop。改动最小,不破坏哑组件性质。

- [ ] **Step 1: 修改 ChatAreaLayoutProps 接口与组件**

把 `src/renderer/src/components/chat/ChatAreaLayout.tsx` 整体替换为:

```tsx
import React, { ReactNode } from 'react';
import Stack from '../ui/Stack';
import { PlanApprovalCard } from './PlanApprovalCard';
import { PlanCapsule } from '../PlanCapsule';
import { useChatStore } from '../../stores/chatStore';

export interface ChatAreaLayoutProps {
  messageArea: ReactNode;
  auditArea?: ReactNode;
  promptArea: ReactNode;
  terminalPanel?: ReactNode;
  panelOpen?: boolean;
  containerRef?: React.RefObject<HTMLDivElement>;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

export const ChatAreaLayout: React.FC<ChatAreaLayoutProps> = ({
  messageArea,
  auditArea,
  promptArea,
  terminalPanel,
  panelOpen,
  containerRef,
  onScroll
}) => {
  return (
    <>
      <Stack
        className={`app-chat-column ${panelOpen ? 'app-chat-column--border' : ''}`}
        ref={containerRef}
        onScroll={onScroll}
      >
        <PlanCapsule />
        <PlanApprovalCard />
        {messageArea}
      </Stack>
      {auditArea}
      {promptArea}
      {terminalPanel}
    </>
  );
};
```

- [ ] **Step 2: 验证类型检查通过**

Run: `cd F:/MyProjectF/CodeZ && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: 无新增错误(可能原有错误,但不应有关于 `ChatAreaLayout` 的错误)。

- [ ] **Step 3: Commit**

```bash
cd F:/MyProjectF/CodeZ
git add src/renderer/src/components/chat/ChatAreaLayout.tsx
git commit -m "feat(ChatAreaLayout): add onScroll passthrough prop"
```

---

### Task 2: ChatArea 核心——状态、阈值、滚动判定与触发

**Files:**
- Modify: `src/renderer/src/components/chat/ChatArea/index.tsx`

**Interfaces:**
- Consumes: `ChatAreaLayoutProps.onScroll`(Task 1 产出)
- Produces: `ChatArea` 内部的 `isFollowing` state、`handleScroll`、`scrollToBottom`、改造后的 `useEffect`

**说明:** 本任务实现滚动行为的核心逻辑,不含按钮 UI(按钮在 Task 3)。完成后应能通过手动验收前 6 项(除按钮相关的显隐/点击)。

- [ ] **Step 1: 新增 import 与模块顶部常量/函数**

在 `src/renderer/src/components/chat/ChatArea/index.tsx` 顶部,修改 React import 行(第 1 行)加入 `useState`:

```ts
import React, { useEffect, useRef, useMemo, useCallback, useState } from 'react'
```

在 import 块之后、`export function extractMessageEdits` 之前(即第 14 行 `import { ChatMessageList } from './components/ChatMessageList'` 之后空一行),新增:

```ts
/** 距底部小于视口高度的此比例算"在底部" */
const SCROLL_BOTTOM_RATIO = 0.15
/** "在底部"阈值的最小像素值(小视口保护) */
const SCROLL_BOTTOM_MIN_PX = 100

function isNearBottom(container: HTMLElement): boolean {
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight
  return distance < Math.max(container.clientHeight * SCROLL_BOTTOM_RATIO, SCROLL_BOTTOM_MIN_PX)
}
```

- [ ] **Step 2: 新增状态与 scrollToBottom**

在 `ChatArea` 函数体内,把现有的:

```ts
  const containerRef = useRef<HTMLDivElement>(null)
  const prevSessionIdRef = useRef<string | null>(null)
```

替换为:

```ts
  const containerRef = useRef<HTMLDivElement>(null)
  const prevSessionIdRef = useRef<string | null>(null)
  const isProgrammaticScroll = useRef(false)
  const [isFollowing, setIsFollowing] = useState(true)
  const [containerMounted, setContainerMounted] = useState(false)

  // containerRef.current 存在后才渲染 portal 按钮
  useEffect(() => {
    if (containerRef.current) setContainerMounted(true)
  }, [])

  const scrollToBottom = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    isProgrammaticScroll.current = true
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight
      // 下一帧再置回 false,确保本帧触发的 scroll 事件被忽略
      requestAnimationFrame(() => {
        isProgrammaticScroll.current = false
      })
    })
  }, [])

  const handleScroll = useCallback(() => {
    // 程序自动滚产生的事件:忽略,不改变跟随态
    if (isProgrammaticScroll.current) return
    const container = containerRef.current
    if (!container) return
    if (isNearBottom(container)) {
      setIsFollowing(true)
    } else {
      setIsFollowing(false)
    }
  }, [])
```

- [ ] **Step 3: 改造现有 useEffect(滚动触发时机)**

把现有的 `useEffect`(原第 167-183 行):

```ts
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const lastMsg = messages[messages.length - 1]
    const isUserLast = lastMsg?.role === 'user'
    const isSessionChanged = prevSessionIdRef.current !== activeSessionId
    prevSessionIdRef.current = activeSessionId

    const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150

    if (isUserLast || isSessionChanged || isAtBottom) {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight
      })
    }
  }, [messages, activeSessionId])
```

替换为:

```ts
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (messages.length === 0) return

    const lastMsg = messages[messages.length - 1]
    const isUserLast = lastMsg?.role === 'user'
    const isSessionChanged = prevSessionIdRef.current !== activeSessionId
    prevSessionIdRef.current = activeSessionId

    const forceFollow = isUserLast || isSessionChanged
    if (forceFollow) {
      setIsFollowing(true)
    }

    if (forceFollow || isFollowing) {
      scrollToBottom()
    }
  }, [messages, activeSessionId, isFollowing, scrollToBottom])
```

- [ ] **Step 4: 给 ChatAreaLayout 传 onScroll**

在 `return (` 里的 `<ChatAreaLayout` 调用,把:

```tsx
    <ChatAreaLayout
      containerRef={containerRef}
      panelOpen={panelOpen}
```

改为:

```tsx
    <ChatAreaLayout
      containerRef={containerRef}
      panelOpen={panelOpen}
      onScroll={handleScroll}
```

- [ ] **Step 5: 类型检查**

Run: `cd F:/MyProjectF/CodeZ && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "ChatArea/index" | head -20`
Expected: 无输出(无 ChatArea/index.tsx 相关错误)。

- [ ] **Step 6: 手动验收(核心行为,无按钮)**

启动应用:`cd F:/MyProjectF/CodeZ && npm run dev`(或项目的开发命令)。

验收:
- [ ] 发送一条消息,流式输出时视图跟随到底部
- [ ] 流式输出过程中,向上滚动 → 视图不再自动跟随(新内容在下方增长但不拉动)
- [ ] 手动滚回底部 → 后续新内容恢复跟随
- [ ] 暂停态下发送新消息 → 强制滚到底并恢复跟随
- [ ] 切换会话 → 回到底部并恢复跟随

- [ ] **Step 7: Commit**

```bash
cd F:/MyProjectF/CodeZ
git add src/renderer/src/components/chat/ChatArea/index.tsx
git commit -m "feat(ChatArea): implement strict-follow autoscroll with isFollowing state

- isFollowing state + isProgrammaticScroll ref (programmatic scroll flagging)
- onScroll handler: scroll-up pauses follow, scroll-back-to-bottom resumes
- scrollToBottom with double-rAF to avoid self-triggered pause
- ratio-based bottom threshold (15% / min 100px) replacing hardcoded 150px
- force-follow on new user message and session switch"
```

---

### Task 3: "回到最新"按钮(Portal + 样式)

**Files:**
- Modify: `src/renderer/src/components/chat/ChatArea/index.tsx`
- Modify: `src/renderer/src/App.css`

**Interfaces:**
- Consumes: `isFollowing`、`scrollToBottom`、`containerMounted`、`containerRef`(Task 2 产出)

**说明:** 本任务加入"回到最新"按钮。暂停态(`isFollowing === false`)时显示,点击恢复跟随并滚到底。按钮通过 `createPortal` 渲染进 `containerRef.current`。样式加到 `App.css`。

- [ ] **Step 1: 新增 createPortal import**

在 `src/renderer/src/components/chat/ChatArea/index.tsx` 第 1 行,把:

```ts
import React, { useEffect, useRef, useMemo, useCallback, useState } from 'react'
```

改为:

```ts
import React, { useEffect, useRef, useMemo, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
```

- [ ] **Step 2: 在组件 return 前,渲染按钮(仅暂停态)**

在 `ChatArea` 函数体内,`return (` 之前(即 `auditMessages` 的 `useMemo` 之后),新增按钮节点变量:

```ts
  const scrollToBottomButton = containerMounted && containerRef.current && !isFollowing
    ? createPortal(
        <button
          type="button"
          className="scroll-to-bottom-btn"
          onClick={() => {
            setIsFollowing(true)
            scrollToBottom()
          }}
          aria-label="回到最新"
        >
          ↓ 回到最新
        </button>,
        containerRef.current
      )
    : null
```

- [ ] **Step 3: 把按钮节点插入渲染树**

在 `return (` 的 `<ChatAreaLayout` 调用里,把 `onScroll={handleScroll}` 那行之后,新增一个 `messageArea` 之外的渲染。但 `ChatAreaLayout` 没有 button slot,按钮通过 portal 已挂到容器内,所以只需把 `scrollToBottomButton` 渲染在 ChatArea 的输出里(它会被 portal 到容器)。

把 `return (` 后的 `<ChatAreaLayout ... />` 改为:

```tsx
  return (
    <>
      {scrollToBottomButton}
      <ChatAreaLayout
        containerRef={containerRef}
        panelOpen={panelOpen}
        onScroll={handleScroll}
        messageArea={
          hasMessages ? (
            <ChatMessageList
              messages={messages}
              lastStreamingMsgId={lastStreamingMsgId}
              handleFileClick={handleFileClick}
              handleDiffClick={handleDiffClick}
            />
          ) : (
            <HomePage onOpenRecentProject={handleOpenRecentProject} />
          )
        }
        auditArea={
          auditMessages.length > 0 ? (
```

(后续 `auditArea`/`promptArea`/`terminalPanel` 内容保持不变,末尾的 `/>` 改为 `/>` + 换行 `</>`。)

即把原来的:

```tsx
  return (
    <ChatAreaLayout
      ...
    />
  )
}
```

改为:

```tsx
  return (
    <>
      {scrollToBottomButton}
      <ChatAreaLayout
        ...
      />
    </>
  )
}
```

**注意**:`<ChatAreaLayout ... />` 内部所有 prop(`messageArea`/`auditArea`/`promptArea`/`terminalPanel` 等)保持原样不动,只在外层包 `<>...</>` 并在最前面加 `{scrollToBottomButton}`。

- [ ] **Step 4: 新增按钮样式到 App.css**

在 `src/renderer/src/App.css` 的 `.app-chat-column--border` 规则(约第 40-42 行)之后,新增:

```css
.scroll-to-bottom-btn {
  position: absolute;
  right: 24px;
  bottom: 24px;
  z-index: 40;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px solid var(--border-color);
  border-radius: 9999px;
  background-color: var(--bg-panel);
  color: var(--text-main);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  opacity: 1;
  transform: translateY(0);
  transition: opacity 150ms ease, transform 150ms ease, box-shadow 150ms ease;
}

.scroll-to-bottom-btn:hover {
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
  border-color: var(--primary-color);
  color: var(--primary-color);
}

.scroll-to-bottom-btn:active {
  transform: translateY(1px);
}
```

- [ ] **Step 5: 类型检查**

Run: `cd F:/MyProjectF/CodeZ && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "ChatArea/index\|App.css" | head -20`
Expected: 无输出。

- [ ] **Step 6: 手动验收(完整)**

启动应用,完整验收全部清单:

- [ ] 流式输出时跟随到底部
- [ ] 向上滚 → 暂停,"↓ 回到最新"按钮出现,新内容不拉动
- [ ] 点按钮 → 恢复跟随,滚到底部,按钮消失
- [ ] 手动滚回底部 → 恢复跟随,按钮消失
- [ ] 读历史(暂停态)时发新消息 → 强制滚到底,恢复跟随,按钮消失
- [ ] 切会话 → 回底部 + 恢复跟随
- [ ] 程序自动滚动不会误触发暂停(流式输出过程中按钮不闪烁出现)
- [ ] 不同视口尺寸下阈值表现正常(缩放窗口测试)

- [ ] **Step 7: Commit**

```bash
cd F:/MyProjectF/CodeZ
git add src/renderer/src/components/chat/ChatArea/index.tsx src/renderer/src/App.css
git commit -m "feat(ChatArea): add 'back to latest' button via portal

- createPortal into scroll container, shown when isFollowing === false
- click resumes follow + scrolls to bottom
- styled as floating pill with blur backdrop, primary-color hover"
```

---

## Self-Review 记录

**Spec coverage:**
- 严格跟随 + onScroll 判定 → Task 2 Step 2-3 ✓
- 程序滚动标记法(双层 rAF)→ Task 2 Step 2 (`scrollToBottom`) ✓
- 比例阈值替换 150px → Task 2 Step 1 (`isNearBottom`) ✓
- 发新消息强制跟随 → Task 2 Step 3 (`forceFollow`) ✓
- 切会话回底部+跟随 → Task 2 Step 3 (`isSessionChanged`) ✓
- 按钮 + 手动滚回恢复 → Task 2 Step 2 (`handleScroll` 滚回恢复) + Task 3 (按钮) ✓
- Portal 渲染按钮 → Task 3 Step 2-3 ✓
- 样式放 App.css → Task 3 Step 4 ✓
- ChatAreaLayout 加 onScroll → Task 1 ✓
- 思考过程不改 → 全程未涉及 ExecutionLog ✓
- 不写测试 → 仅手动验收 ✓

**Placeholder scan:** 无 TBD/TODO,所有步骤含完整代码。

**Type consistency:** `isFollowing`(boolean)、`scrollToBottom`(()=>void)、`handleScroll`(()=>void)、`isNearBottom`((HTMLElement)=>boolean)在 Task 2 定义、Task 3 消费,签名一致。`ChatAreaLayoutProps.onScroll` 在 Task 1 定义、Task 2 消费,一致。

**潜在风险(已在计划中处理):**
- `containerRef.current` 首次渲染为 null → 用 `containerMounted` state + `useEffect` 在挂载后 setReady(Task 2 Step 2)
- `useEffect` 依赖加 `isFollowing`/`scrollToBottom` → 已在 Task 2 Step 3 依赖数组体现,避免 stale closure
