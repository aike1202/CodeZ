# 聊天区自动滚动 vs 用户操作 设计

**日期**: 2026-07-03
**范围**: 仅聊天主滚动区 `src/renderer/src/components/chat/ChatArea/index.tsx`
**状态**: 已确认设计,待实现

---

## 背景与问题

当前聊天区唯一的自动滚动实现位于 `src/renderer/src/components/chat/ChatArea/index.tsx:167-183`:

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
    requestAnimationFrame(() => { container.scrollTop = container.scrollHeight })
  }
}, [messages, activeSessionId])
```

**存在的问题:**

1. **无跟随状态**:每次 `messages` 变化时重算 `isAtBottom`,系统虽然不会在用户读历史时强行拉动(因为不在底部),但没有状态记住"用户在读历史",无法提供恢复跟随的入口和暂停指示。
2. **无 onScroll 监听**:无法感知用户主动滚动,无法实现"向上滚即暂停"。
3. **无恢复跟随入口**:暂停后没有"回到底部"按钮,用户只能手动滚,但下一个 chunk 又判断"不在底部"而不跟随,体验断裂。
4. **硬编码阈值**:150px 阈值无法适配不同视口尺寸(已有设计文档 `2026-06-30-chat-area-optimization-design.md:802-818` 标记为已知问题)。

**数据流背景**(仅作上下文,本次不改):流式数据经 Electron IPC(`CHAT_STREAM_CHUNK` 等)→ preload `chat.stream` 回调 → zustand `messageSlice.appendStreamChunk`/`startToolCall` → `messages` 数组变化 → `ChatArea` 的 `useEffect` 重新跑滚动检查。

---

## 设计目标

实现"严格跟随"模式的自动滚动:

- 用户在底部时,新内容自动滚到底部(跟随)
- 用户向上滚去读历史时,立即暂停跟随,新内容静默追加不拉动
- 提供显式恢复跟随入口(按钮 + 手动滚回底部)
- 程序自动滚动产生的 scroll 事件不被误判为用户操作
- 修掉硬编码阈值

---

## 需求确认(已与用户逐项确认)

| # | 需求 | 决定 |
|---|---|---|
| 1 | 范围 | 只做 `ChatArea/index.tsx` 聊天主滚动区 |
| 2 | 跟随语义 | 严格跟随——用户向上滚立即暂停,新内容不自动滚 |
| 3 | 恢复跟随 | 按钮 + 手动滚回底部,双路径 |
| 4 | 暂停判定 | 程序滚动标记法(`isProgrammaticScroll` ref) |
| 5 | 发新消息时 | 强制跟随(覆盖当前暂停态) |
| 6 | 会话切换时 | 回底部 + 恢复跟随 |
| 7 | 阈值 | 比例阈值替换 150px(视口 15%,最小 100px) |
| 8 | 实现方案 | 方案 A:内联在 ChatArea,`isFollowing` 为 ChatArea 局部 state,不下传 |
| 9 | 思考过程展开/折叠 | **不在本次范围**,保持现状(现状已满足"正在思考时展开、进入下一步收缩") |

---

## 架构:状态模型与核心机制

### 新增状态(全部在 `ChatArea/index.tsx` 内)

| 状态 | 类型 | 作用 |
|---|---|---|
| `isFollowing` | `useState<boolean>` | 是否跟随底部。初始 `true`。`true` 时新内容自动滚到底;`false` 时暂停。 |
| `isProgrammaticScroll` | `useRef<boolean>` | 标记当前滚动是否由程序触发。自动滚动前置 `true`,rAF 回调里置回 `false`。 |
| `prevSessionIdRef` | 已有 `useRef` | 复用,检测会话切换。 |

`isFollowing` 是纯 ChatArea 局部状态,**不下传**给子组件(思考过程展开/折叠需求已确认不依赖它)。

### 阈值常量与 `isNearBottom` 函数(模块顶部)

```ts
const SCROLL_BOTTOM_RATIO = 0.15
const SCROLL_BOTTOM_MIN_PX = 100

function isNearBottom(container: HTMLElement): boolean {
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight
  return distance < Math.max(container.clientHeight * SCROLL_BOTTOM_RATIO, SCROLL_BOTTOM_MIN_PX)
}
```

语义:距底部 < 视口高度 15% 且最少 100px 时算"在底部"。视口 800px → 阈值 120px;视口 500px → 阈值 100px(触底保护)。用于 `handleScroll` 判断"用户滚回底部 → 恢复跟随"。

---

## 行为设计

### `handleScroll`(挂到滚动容器的 `onScroll`)

```
onScroll 触发时:
  1. 若 isProgrammaticScroll.current === true → 程序自动滚产生的事件,直接 return(不判定、不暂停)
  2. 否则是用户主动滚动:
     a. 计算 isAtBottom = isNearBottom(container)
     b. 若 isAtBottom === true  → setIsFollowing(true)   // 用户手动滚回底部 → 恢复跟随
     c. 若 isAtBottom === false → setIsFollowing(false)  // 用户向上滚 → 暂停跟随
```

**关键点**:程序滚动标记法确保"自动滚到底"这个动作本身不会把自己误判成用户滚动而进入暂停。标记在 `scrollToBottom` 里置 `true`,在双层 rAF 后置回 `false`(见下)。因为 rAF 在同一帧执行,浏览器在帧末触发的 scroll 事件会看到 `true` 而被忽略;下一帧用户的真实滚动看到 `false`,正常判定。

### 自动滚动触发时机(改造现有 `useEffect`,依赖 `[messages, activeSessionId]`)

```
触发时:
  1. 若 messages.length === 0 → return
  2. 计算 lastMsg = messages[length-1]
  3. isUserLast = lastMsg?.role === 'user'
  4. isSessionChanged = prevSessionIdRef.current !== activeSessionId
     (随后更新 prevSessionIdRef.current = activeSessionId)

  执行滚动的条件(满足任一):
    a. isUserLast          → 用户发了新消息 → 强制跟随
    b. isSessionChanged    → 切换了会话 → 强制跟随
    c. isFollowing === true → 当前在跟随态 → 跟随新内容

  若 a 或 b 成立(强制跟随场景):
    先 setIsFollowing(true)   // 把状态拉回跟随,避免"强制滚了但 isFollowing 还是 false"的不一致
  若 a/b/c 任一成立:
    执行 scrollToBottom()
  否则(暂停态且非用户消息/非切会话):
    什么都不做 → 新内容静默追加,用户继续读历史
```

**与现有代码的对应:**
- 现状的 `isUserLast || isSessionChanged || isAtBottom` → 改为 `isUserLast || isSessionChanged || isFollowing`
- `isAtBottom` 这个"位置重算"被 `isFollowing` 这个"状态查询"取代,语义从"现在在不在底部"升级为"用户想不想跟随"
- 强制场景补 `setIsFollowing(true)`,保证状态一致

### `scrollToBottom`(内部函数)

```ts
const scrollToBottom = useCallback(() => {
  const container = containerRef.current
  if (!container) return
  isProgrammaticScroll.current = true
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight
    // 下一帧再置回 false,确保本帧触发的 scroll 事件被忽略
    requestAnimationFrame(() => { isProgrammaticScroll.current = false })
  })
}, [])
```

用双层 rAF:第一帧执行滚动并保持标记 `true`(吸收该帧的 scroll 事件),第二帧置回 `false` 让后续用户滚动恢复正常判定。这是处理"自动滚动产生的 scroll 事件"最稳妥的时序。

---

## UI 元素:回到底部按钮

### 显示逻辑

```
显示条件: isFollowing === false  (暂停态时显示)
隐藏条件: isFollowing === true   (跟随态时隐藏)
```

按钮的存在即表示"已暂停跟随",不额外加文字提示,避免噪音。

### 位置与外观

按钮挂在滚动容器(`.app-chat-column`,已有 `position: relative`)内,绝对定位右下角,浮在消息内容之上。

```
┌─────────────────────────────────┐
│  消息 1                          │
│  消息 2                          │
│  消息 3 (用户在读这里)            │
│                                  │
│              [新内容在下方增长…]  │ ← 用户看不到(暂停了)
│                       ┌───────┐ │
│                       │ ↓ 回到 │ │ ← 浮动按钮,右下角
│                       │  最新  │ │
│                       └───────┘ │
└─────────────────────────────────┘
```

**文案**:"↓ 回到最新"(向下箭头 + 文字)。
**视觉**:圆角胶囊,半透明背景(`rgba` + `backdrop-filter: blur`),悬停加深,带 `box-shadow` 浮起感。配色跟随项目现有 CSS 变量(`var(--bg-panel)` / `var(--border-color)` 等)。
**动画**:`opacity` + 轻微 `translateY` 过渡(150ms),避免突兀。

### 渲染方式:React Portal

按钮通过 `createPortal(buttonNode, containerRef.current)` 渲染进滚动容器。

- **不改 `ChatAreaLayout.tsx`** —— Layout 保持哑组件,只管布局
- 按钮的状态(`isFollowing`)与交互(`onClick`)完全在 ChatArea 内闭环
- `containerRef.current` 在首次渲染时为 null,需在 `useEffect` 里 setReady(或用一个 `mounted` state),确保 `containerRef.current` 存在时才渲染 portal
- 按钮作为滚动容器子节点(绝对定位),脱离文档流,不影响 `scrollHeight` 计算

### 点击行为

```
onClick:
  1. setIsFollowing(true)
  2. scrollToBottom()
```

---

## 文件改动清单

共改动 **3 个文件**:

| 操作 | 文件 | 改动 |
|---|---|---|
| MODIFY | `src/renderer/src/components/chat/ChatArea/index.tsx` | 新增 `isFollowing` state、`isProgrammaticScroll` ref、`isNearBottom` 函数与阈值常量、`handleScroll`、`scrollToBottom`;改造 `useEffect`(用 `isFollowing` 替代 `isAtBottom` 重算,强制场景补 `setIsFollowing(true)`);把 `onScroll={handleScroll}` 透传给 `ChatAreaLayout`;用 `createPortal` 把"回到最新"按钮渲染进 `containerRef.current`(需 `mounted` state 确保 `containerRef.current` 存在) |
| MODIFY | `src/renderer/src/components/chat/ChatAreaLayout.tsx` | 新增可选 prop `onScroll?: (e: React.UIEvent<HTMLDivElement>) => void`,透传到 `<Stack onScroll={onScroll}>`。仅加一个透传 prop,不破坏哑组件性质 |
| MODIFY | `src/renderer/src/App.css` | 新增 `.scroll-to-bottom-btn` 样式(绝对定位右下、半透明背景 + `backdrop-filter: blur`、hover 加深、`opacity`+`translateY` 过渡 150ms)。注:`.app-chat-column` 已有 `position: relative`(App.css:37),无需再加 |

**onScroll 透传说明**:滚动容器 `<Stack ref={containerRef}>` 渲染在 `ChatAreaLayout.tsx:26`。`ChatAreaLayout` 当前只接收 `containerRef`,不接收事件回调,故需新增 `onScroll` prop 透传。这是对 `ChatAreaLayout.tsx` 的唯一改动。

---

## 不在本次范围

- **思考过程(ExecutionLog 推理块)的展开/折叠**:保持现状。现状(`ExecutionLog/index.tsx:66-83` 的 per-item effect)已满足"正在思考时展开、进入下一步收缩"。其"手动展开会被下一个 chunk 覆盖"的行为也按用户确认保留,本次不改。
- **ExecutionLog 整条时间线的展开/折叠**:不在范围。
- **TerminalPanel(xterm)的滚动**:不在范围,xterm 有自己的内置滚动。
- **测试**:本次不写单元/组件测试。滚动行为在 jsdom 里 mock 成本高、收益低,靠手动验收。

---

## 手动验收清单

- [ ] 流式输出时跟随到底部
- [ ] 向上滚 → 暂停,按钮出现,新内容不拉动
- [ ] 点按钮 → 恢复跟随,滚到底部,按钮消失
- [ ] 手动滚回底部 → 恢复跟随,按钮消失
- [ ] 读历史(暂停态)时发新消息 → 强制滚到底,恢复跟随
- [ ] 切会话 → 回底部 + 恢复跟随
- [ ] 程序自动滚动不会误触发暂停(流式输出过程中不出现按钮闪烁)
- [ ] 不同视口尺寸下阈值表现正常(小视口 ≥100px,大视口 15%)

---

## 关键文件引用

- 现有滚动实现:`src/renderer/src/components/chat/ChatArea/index.tsx:167-183`
- 滚动容器样式:`src/renderer/src/App.css:33-38`(`.app-chat-column`,已有 `position: relative`)
- 滚动容器渲染:`src/renderer/src/components/chat/ChatAreaLayout.tsx:26`
- 已有阈值问题记录:`docs/superpowers/specs/2026-06-30-chat-area-optimization-design.md:802-818`
