# 对话区域 P0 优化设计文档

**日期：** 2026-06-30  
**范围：** `src/renderer/src/components/chat/` 及相关文件  
**策略：** 分层渐进（方案 B），本轮为第一轮 — 聚焦 P0 问题  

---

## 1. 背景与目标

CodeZ 是一个基于 Electron + React + TypeScript 的 AI 编程助手桌面应用。对话区域（Chat Area）是用户与 AI 交互的核心界面，包含消息列表、工具调用执行日志（ExecutionLog）、Markdown 渲染（MessageBody）、编辑审批（EditApprovalWidget）等子系统。

经过全面代码审查，发现 24 个问题，按优先级分为 P0（4 项）、P1（4 项）、P2（7 项）、P3（9 项）。

**本轮目标：** 解决全部 4 个 P0 问题，同时顺带修复 2 个低成本的 Bug 级别问题。

### 成功标准

1. `parseInline` 不再在函数体内调用 `useWorkspaceStore.getState()`
2. `lastStreamingMsgId` 仅计算一次，不在 `messages.map()` 内重复
3. diff 计算逻辑只存在于一处（`editDiffUtils.ts`），其他文件通过导入使用
4. `parseInline` 支持 `*italic*`、`~~strikethrough~~`、`[link](url)` 三种新格式
5. CSS 拼写错误 `min-w` 修复为 `min-width`
6. `ChatAreaLayout` 的 className 符合项目规则（最多 2 个样式类）

---

## 2. 架构概览

### 变更前的调用关系

```
ChatArea.tsx (621行)
├── extractMessageEdits()      ← 内含 diff 计算 (switch-case ×4)
├── handleApprovalDiffClick()  ← 内含 diff 构建 (switch-case ×4)
├── 消息渲染 (IIFE ×2)
│   ├── ExecutionLog.tsx
│   │   ├── onClick 文件名    ← 内含 diff 构建 (switch-case ×4)  ⬅ 重复!
│   │   └── onClick diff链接  ← 内含 diff 构建 (switch-case ×4)  ⬅ 重复!
│   └── MessageBody.tsx
│       └── parseInline()     ← 内部调用 getState()              ⬅ 性能问题!
└── auditArea
    └── extractMessageEdits() ← 同一渲染周期重复调用              ⬅ 浪费!
```

### 变更后的调用关系

```
ChatArea.tsx (减少 ~100行)
├── editDiffUtils.computeEditStats()    ← 统一入口
├── editDiffUtils.handleDiffClickForFile()
├── lastStreamingMsgId                  ← map 外计算一次
├── auditMessages                       ← useMemo 缓存
│   ├── ExecutionLog.tsx
│   │   └── editDiffUtils.buildDiffEditInfo()   ← 统一入口
│   └── MessageBody.tsx
│       └── parseInline(text, onFileClick, cursor, validFiles)  ← 参数传入
└── [新] editDiffUtils.ts (~80行)
```

---

## 3. 详细设计

### 3.1 新建 `editDiffUtils.ts`

**位置：** `src/renderer/src/utils/editDiffUtils.ts`

**职责：** 统一管理 diff 相关的计算和交互逻辑。

#### 导出函数

```typescript
import { parseArgs } from './parseArgs'

/**
 * 计算单个工具调用的行数变更统计。
 * 统一处理 write_to_file / replace_file_content / multi_replace_file_content / apply_patch 四种工具。
 */
export function computeEditStats(
  toolName: string,
  args: string
): { additions: string; deletions: string }

/**
 * 根据工具调用构建 diff 预览所需的 editInfo 对象。
 * 返回值可直接传给 handleDiffClick。
 */
export function buildDiffEditInfo(
  toolName: string,
  args: string
): {
  type: 'write' | 'replace'
  targetContent?: string
  replacementContent?: string
  codeContent?: string
}

/**
 * 从工具调用列表中找到匹配文件路径的工具，构建 editInfo 并触发 diff 预览。
 * 如果找不到匹配的工具调用，fallback 到文件预览。
 */
export function handleDiffClickForFile(
  filePath: string,
  tools: Array<{ name: string; args: string }>,
  handleDiffClick: (filePath: string, editInfo: any) => void,
  handleFileClick: (filePath: string) => void
): void
```

#### 设计决策

- `computeEditStats` 和 `buildDiffEditInfo` 是**纯函数**，无副作用，便于测试
- `handleDiffClickForFile` 封装了文件路径匹配 + diff 构建 + fallback 逻辑
- 路径匹配使用已有的 normalize 逻辑（`replace(/\\\\/g, '/').toLowerCase()`）

---

### 3.2 修改 `MessageParser.ts`

#### 3.2.1 `parseInline` 签名变更

```typescript
// Before
export function parseInline(
  text: string,
  onFileClick: (path: string) => void,
  showCursor = false
): React.ReactNode[]

// After
export function parseInline(
  text: string,
  onFileClick: (path: string) => void,
  showCursor = false,
  validFiles?: Set<string>
): React.ReactNode[]
```

函数体内所有 `useWorkspaceStore.getState().validFiles` 替换为使用传入的 `validFiles` 参数。当参数为 `undefined` 时，使用空 `Set` 作为 fallback（即不做文件匹配）。

#### 3.2.2 新增内联格式

在 `parseInline` 的匹配优先级链中新增三种格式：

| 优先级 | 格式 | 正则 | 渲染元素 |
|:---:|:---|:---|:---|
| 1 | Markdown 链接 | `/\[([^\]]+)\]\(([^)]+)\)/` | `<a href="url" target="_blank" rel="noopener noreferrer">` |
| 2 | 加粗 | `**text**`（已有） | `<strong>` |
| 3 | 斜体 | `/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/` | `<em>` |
| 4 | 删除线 | `/~~(.+?)~~/` | `<del>` |
| 5 | 行内代码 | `` `code` ``（已有） | `<code>` |
| 6 | 文件路径 | （已有） | `<span class="file-link">` |
| 7 | 斜杠命令 | （修复后） | `<span class="cmd-inline-link">` |

**斜体匹配的注意点：** 使用 lookbehind/lookahead 确保 `*italic*` 不与 `**bold**` 冲突。即单个 `*` 前后不能紧接另一个 `*`。

#### 3.2.3 修复 `/command` 正则

```typescript
// Before - 匹配任何 /word，导致文件路径误匹配
const COMMAND_RE = /(/[a-zA-Z0-9_-]+)/g

// After - 只匹配行首或空格后的斜杠命令
const COMMAND_RE = /(?:^|\s)(\/[a-zA-Z0-9_-]+)/g
```

---

### 3.3 修改 `MessageBody.tsx`

在组件层面获取 `validFiles` 并传入所有 `parseInline` 调用：

```typescript
import { useWorkspaceStore } from '../../stores/workspaceStore'

export default function MessageBody({ content, streaming, reasoning, onFileClick }) {
  const validFiles = useWorkspaceStore((s) => s.validFiles)
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content])

  // 所有 parseInline(text, onFileClick, showCursor) 调用
  // 改为 parseInline(text, onFileClick, showCursor, validFiles)
}
```

**影响范围：** `parseInline` 在 MessageBody 中被调用约 10 处（段落、列表项、表格单元格、标题等），全部需要传入第四参数。

---

### 3.4 修改 `ChatArea.tsx`

#### 3.4.1 提前计算 `lastStreamingMsgId`

在 `messages.map()` 之前用 `useMemo` 计算：

```typescript
const lastStreamingMsgId = useMemo(() => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'agent' && messages[i].streaming) {
      return messages[i].id
    }
  }
  return null
}, [messages])
```

#### 3.4.2 替换 `extractMessageEdits` 中的 diff 计算

将 4-way switch-case 替换为调用 `computeEditStats`：

```typescript
import { computeEditStats } from '../../utils/editDiffUtils'

// Before: 50+ 行的 switch-case
// After:
const { additions, deletions } = computeEditStats(tc.name, tc.args)
```

注意：`extractMessageEdits` 函数中还有 `diffEntries` 的匹配逻辑（使用真实 diff 覆盖计算值），这部分保留在 `extractMessageEdits` 中。

#### 3.4.3 替换 `handleApprovalDiffClick`

```typescript
import { handleDiffClickForFile } from '../../utils/editDiffUtils'

// Before: 65 行的函数
// After: 直接导出并使用 handleDiffClickForFile
export { handleDiffClickForFile as handleApprovalDiffClick } from '../../utils/editDiffUtils'
```

#### 3.4.4 缓存 auditMessages

```typescript
const auditMessages = useMemo(() => {
  return messages.filter(m => {
    const hasPendingPermission = m.permissionRequests?.some((r: any) => r.status === 'pending')
    const { edits } = extractMessageEdits(m)
    const hasPendingEdits = edits.length > 0 && !edits.every((e: any) => m.editStatuses?.[e.filePath])
    return hasPendingPermission || hasPendingEdits
  })
}, [messages])
```

---

### 3.5 修改 `ExecutionLogUtils.ts`

`buildUnifiedTimeline` 中的 additions/deletions 计算（L282-L324）替换为：

```typescript
import { computeEditStats } from '../../utils/editDiffUtils'

// Before: 40+ 行的 switch-case
// After:
const { additions, deletions } = computeEditStats(tc.name, tc.args)
```

---

### 3.6 修改 `ExecutionLog.tsx`

#### 合并重复的 diff 点击逻辑

将文件名点击（L250-L353）和 diff 链接点击（L381-L426）中的 diff 构建逻辑替换为统一的 helper：

```typescript
import { buildDiffEditInfo } from '../../utils/editDiffUtils'

const handleEditItemClick = (item: UnifiedTimelineItem) => {
  const editInfo = buildDiffEditInfo(item.toolName || '', item.args || '')
  onDiffClick?.(item.target, editInfo)
}
```

两处 onClick 回调都调用这个统一的 handler。

---

### 3.7 CSS 修复

#### `MessageBody.css`

```css
/* Before */
.msg-list-content {
  min-w: 0;
}

/* After */
.msg-list-content {
  min-width: 0;
}
```

#### `ChatAreaLayout.tsx` + `App.css`

```tsx
// Before
<Stack className={`app-chat-column flex-1 overflow-y-auto relative ${panelOpen ? 'app-chat-column--border' : ''}`}

// After
<Stack className={`app-chat-column ${panelOpen ? 'app-chat-column--border' : ''}`}
```

```css
/* App.css 中补充 */
.app-chat-column {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  position: relative; /* 新增 */
}
```

---

## 4. 不变的部分

以下内容本轮**不修改**：

- `ChatArea.tsx` 中 `handleSendMessage` 的 API 通信逻辑
- `ChatArea.tsx` 中的 IIFE 渲染结构（P1 问题，下一轮处理）
- `ExecutionLog` 的展开/折叠行为
- `CodeBlock` 语法高亮（P1 问题）
- `ThinkingBlock` / `ToolCallLog` 的清理（P3 问题）
- 类型系统改进（`any` → 强类型，P3 问题）

---

## 5. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|:---|:---|:---|
| `parseInline` 签名变更导致漏传 `validFiles` | 文件路径不高亮 | Fallback 为空 Set，功能降级而非报错 |
| 斜体正则与加粗冲突 | `*text*` 被误渲染 | 使用 lookbehind/lookahead，优先匹配 `**` |
| `/command` 正则修复后可能漏匹配 | 行首命令不识别 | 使用 `(?:^|\s)` 同时匹配行首和空格后 |
| `editDiffUtils` 导入路径错误 | 编译失败 | TypeScript `--noEmit` 验证 |

---

## 6. 验证计划

1. **编译检查：** `npx tsc --noEmit` — 确保无类型错误
2. **功能验证：**
   - 发送包含 `*斜体*`、`~~删除线~~`、`[链接](https://example.com)` 的消息
   - 触发工具调用，验证 ExecutionLog 中 diff 点击跳转正常
   - 验证文件编辑审批流程不受影响
3. **性能验证：** 在 20+ 条消息的对话中观察渲染流畅性
4. **回归验证：** 已有的加粗、行内代码、文件路径链接功能不受影响

---

## 7. 文件变更清单

| 操作 | 文件路径 | 改动摘要 |
|:---:|:---|:---|
| **NEW** | `src/renderer/src/utils/editDiffUtils.ts` | 提取公共 diff 计算/构建/点击逻辑 |
| MODIFY | `src/renderer/src/components/chat/MessageParser.ts` | 参数化 validFiles + 新增内联格式 + 修复命令正则 |
| MODIFY | `src/renderer/src/components/chat/MessageBody.tsx` | 传入 validFiles 参数 |
| MODIFY | `src/renderer/src/components/chat/MessageBody.css` | 修复 `min-w` → `min-width` |
| MODIFY | `src/renderer/src/components/chat/ChatArea.tsx` | 提取 lastStreamingMsgId + 使用 editDiffUtils + 缓存 auditMessages |
| MODIFY | `src/renderer/src/components/chat/ExecutionLogUtils.ts` | 使用 computeEditStats |
| MODIFY | `src/renderer/src/components/chat/ExecutionLog.tsx` | 合并 diff 点击逻辑 + 使用 buildDiffEditInfo |
| MODIFY | `src/renderer/src/components/chat/ChatAreaLayout.tsx` | 修复 className 规则违规 |
| MODIFY | `src/renderer/src/App.css` | 新增 `position: relative` |

---
---

# 第二轮：P1 优化（架构 + 可读性 + 用户体验）

> **状态：** 📋 待实施（需 P0 完成并稳定后启动）

## P1-1：ChatArea.tsx 拆分（原问题 #6）

**当前问题：** `ChatArea.tsx` 621 行，混合了数据处理、API 通信和 UI 渲染三种职责。

**改造方案：**

### 第一步：提取 `useSendMessage` 自定义 Hook

将 `handleSendMessage`（~150 行）迁移到 `src/renderer/src/hooks/useSendMessage.ts`：

```typescript
// hooks/useSendMessage.ts
export function useSendMessage() {
  const addUserMessage = useChatStore((s) => s.addUserMessage)
  const startStreamingReply = useChatStore((s) => s.startStreamingReply)
  // ... 其余 store 订阅

  const handleSendMessage = useCallback(async (message: string, modelName: string) => {
    // 完整的发送逻辑
  }, [/* deps */])

  return handleSendMessage
}
```

### 第二步：提取 `AgentMessageContent` 子组件

将 ChatArea 中两个 IIFE（原问题 #2）替换为独立组件：

```typescript
// chat/AgentMessageContent.tsx
interface AgentMessageContentProps {
  msg: ChatMessage
  isStreaming: boolean
  onFileClick: (filePath: string) => void
  onDiffClick: (filePath: string, editInfo: any) => void
}

export function AgentMessageContent({ msg, isStreaming, onFileClick, onDiffClick }: AgentMessageContentProps) {
  // 第一个 IIFE 的逻辑：executionTimeline vs 纯文本分支
  // 第二个 IIFE 的逻辑：editStatuses / EditApprovalWidget
}
```

### 预期效果

| 文件 | 变更前 | 变更后 |
|:---|:---:|:---:|
| `ChatArea.tsx` | 621 行 | ~300 行 |
| `useSendMessage.ts` | — | ~160 行 |
| `AgentMessageContent.tsx` | — | ~100 行 |

### 涉及文件

| 操作 | 文件 |
|:---:|:---|
| NEW | `src/renderer/src/hooks/useSendMessage.ts` |
| NEW | `src/renderer/src/components/chat/AgentMessageContent.tsx` |
| MODIFY | `src/renderer/src/components/chat/ChatArea.tsx` |

---

## P1-2：ExecutionLog 内部 diff 逻辑重复消除（原问题 #8）

**当前问题：** `ExecutionLog.tsx` 中文件名点击（L250-L353）和 diff 链接点击（L381-L426）包含几乎完全相同的 diff 构建逻辑。

**改造方案：**

> [!NOTE]
> 如果 P0 中 `editDiffUtils.ts` 已就绪，本项工作量极小 — 只需将 ExecutionLog 中的两处 onClick 回调统一调用 `buildDiffEditInfo`，然后删除内联的重复代码。
>
> P0 轮已包含部分改造。本项确保彻底清理残留。

### 具体改动

1. 在 `ExecutionLog.tsx` 中新增一个私有 helper：

```typescript
const handleEditItemClick = (item: UnifiedTimelineItem) => {
  if (!item.toolName || !item.args) return
  const editInfo = buildDiffEditInfo(item.toolName, item.args)
  onDiffClick?.(item.target, editInfo)
}
```

2. 文件名 `<span>` 的 onClick → `handleEditItemClick(item)`
3. diff 链接 `<span>` 的 onClick → `handleEditItemClick(item)`
4. 删除两处内联的 switch-case 代码（预计减少 ~80 行）

### 涉及文件

| 操作 | 文件 |
|:---:|:---|
| MODIFY | `src/renderer/src/components/chat/ExecutionLog.tsx` |

---

## P1-3：CodeBlock 语法高亮（原问题 #22）

**当前问题：** `CodeBlock.tsx` 只将代码放入 `<pre><code>` 中，无语法高亮。对 AI 编程助手来说这是体验硬伤。

**改造方案：**

### 方案选择

| 方案 | 优点 | 缺点 |
|:---|:---|:---|
| **Highlight.js** | 轻量、语言支持多、主题丰富 | 需额外 npm 依赖 |
| **Prism.js** | 更小巧、插件系统 | 语言包需手动引入 |
| **CodeMirror（已有）** | 项目已依赖、功能强大 | 代码块用 CM 太重 |

**推荐：Highlight.js** — 项目中的代码块是只读展示，不需要编辑能力，highlight.js 最合适。

### 具体改动

1. 安装依赖：`npm install highlight.js`
2. 在 `CodeBlock.tsx` 中集成：

```typescript
import hljs from 'highlight.js/lib/core'
// 按需注册常用语言
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import css from 'highlight.js/lib/languages/css'
import python from 'highlight.js/lib/languages/python'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import xml from 'highlight.js/lib/languages/xml'
import diff from 'highlight.js/lib/languages/diff'

hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('tsx', typescript)
// ... 其他注册

// 在组件中使用 hljs.highlight(code, { language: lang })
```

3. 引入一个暗色主题 CSS（如 `github-dark`），与项目整体暗色风格一致
4. 处理 streaming 状态下的增量高亮（可选：streaming 时不高亮，完成后再渲染高亮版本）

### 涉及文件

| 操作 | 文件 |
|:---:|:---|
| MODIFY | `src/renderer/src/components/chat/CodeBlock.tsx` |
| NEW | 引入 highlight.js 主题 CSS（或在 CodeBlock.css 中内联） |
| MODIFY | `package.json`（新增 highlight.js 依赖） |

---

## P1-4：CSS 拼写错误修复（原问题 #23）

> [!NOTE]
> 此项已在 P0 轮中处理。保留此条目作为记录。

✅ 已在 P0 完成。

---
---

# 第三轮：P2 优化（UX 细节 + 规范一致性）

> **状态：** 📋 待实施（需 P1 完成后启动）

## P2-1：用户消息气泡缺少高度限制（原问题 #3）

**当前问题：** 用户粘贴大段文本时，气泡无限撑高。

**改造方案：**

```css
.user-message-bubble {
  /* 已有样式保留 */
  max-height: 400px;
  overflow-y: auto;
}

/* 添加滚动指示 —— 底部渐变遮罩 */
.user-message-bubble.has-overflow::after {
  content: '';
  position: sticky;
  bottom: 0;
  display: block;
  height: 24px;
  background: linear-gradient(transparent, var(--bg-panel));
  pointer-events: none;
}
```

需要在 `ChatArea.tsx` 中用 ref 或 ResizeObserver 检测是否溢出并添加 `has-overflow` class。

### 涉及文件

| 操作 | 文件 |
|:---:|:---|
| MODIFY | `src/renderer/src/App.css` |
| MODIFY | `src/renderer/src/components/chat/ChatArea.tsx`（可选，检测溢出） |

---

## P2-2：Agent 头像只是 "AI" 纯文本（原问题 #4）

**当前问题：** Agent 头像区域只显示 "AI" 两个字，缺乏品牌辨识度。

**改造方案：**

设计一个 SVG 图标组件 `AgentAvatarIcon`：

```typescript
// svg-icons/AgentAvatarIcon.tsx
export function AgentAvatarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
      {/* 简约的 AI/机器人图标 */}
    </svg>
  )
}
```

替换 ChatArea 中的硬编码文本：

```diff
-<Flex align="center" justify="center" className="agent-avatar">
-  AI
-</Flex>
+<Flex align="center" justify="center" className="agent-avatar">
+  <AgentAvatarIcon />
+</Flex>
```

### 涉及文件

| 操作 | 文件 |
|:---:|:---|
| NEW | `src/renderer/src/components/svg-icons/AgentAvatarIcon.tsx`（或在现有 svg-icons 中添加） |
| MODIFY | `src/renderer/src/components/chat/ChatArea.tsx` |

---

## P2-3：ChatAreaLayout className 违反规则（原问题 #13）

> [!NOTE]
> 此项已在 P0 轮中处理。保留此条目作为记录。

✅ 已在 P0 完成。

---

## P2-4：ExecutionLogDetail 中混用 Tailwind（原问题 #14）

**当前问题：** `ExecutionLogDetail.tsx` L174-L206 中搜索结果区域大量使用 Tailwind 内联类，与项目其余部分的纯 CSS 类风格不一致。

**改造方案：**

将所有 Tailwind 内联类迁移到 `ExecutionLog.css` 中的具名 CSS 类：

```css
/* ExecutionLog.css — 新增 */
.exe-log-search-result-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  background-color: var(--bg-primary, #ffffff);
  border-radius: 6px;
  border: 1px solid var(--border-light);
  transition: border-color 0.15s;
}

.exe-log-search-result-card:hover {
  border-color: var(--border-color);
}

.exe-log-search-result-path {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-main);
  transition: color 0.15s;
}

.exe-log-search-result-path:hover {
  color: var(--primary-color);
}

.exe-log-search-result-code {
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  line-height: 1.625;
  padding: 6px 8px;
  background-color: var(--bg-hover);
  border-radius: 4px;
  color: var(--text-muted);
  overflow-x: auto;
  white-space: pre;
}

.exe-log-search-truncated {
  font-size: 11px;
  color: #f59e0b;
  font-style: italic;
  padding: 4px 8px;
  background-color: rgba(245, 158, 11, 0.05);
  border-radius: 4px;
  width: fit-content;
}
```

### 涉及文件

| 操作 | 文件 |
|:---:|:---|
| MODIFY | `src/renderer/src/components/chat/ExecutionLogDetail.tsx` |
| MODIFY | `src/renderer/src/components/chat/ExecutionLog.css` |

---

## P2-5：ExecutionLog 完成后立即折叠（原问题 #16）

**当前问题：** 工具调用完成后 timeline 立刻折叠，用户可能想查看刚才的操作。

**改造方案：**

```typescript
// ExecutionLog.tsx
useEffect(() => {
  if (running) {
    setExpanded(true)
  } else {
    // 延迟折叠：操作少时不折叠，操作多时延迟 2 秒
    if (unifiedItems.length <= 3) {
      // 3 项以内，保持展开不折叠
      return
    }
    const timer = setTimeout(() => setExpanded(false), 2000)
    return () => clearTimeout(timer)
  }
}, [running, unifiedItems.length])
```

### 涉及文件

| 操作 | 文件 |
|:---:|:---|
| MODIFY | `src/renderer/src/components/chat/ExecutionLog.tsx` |

---

## P2-6：extractMessageEdits 在 auditArea 重复计算（原问题 #19）

> [!NOTE]
> 此项已在 P0 轮中通过 `useMemo` 缓存处理。保留此条目作为记录。

✅ 已在 P0 完成。

---

## P2-7：`/command` 正则误匹配（原问题 #24）

> [!NOTE]
> 此项已在 P0 轮中修复。保留此条目作为记录。

✅ 已在 P0 完成。

---
---

# 第四轮：P3 优化（清洁度 + 健壮性 + 微调）

> **状态：** 📋 待实施（可选，视时间安排推进）

## P3-1：清理疑似弃用的 ToolCallLog（原问题 #9）

**验证步骤：**

1. 全项目搜索 `ToolCallLog` 的导入/引用
2. 如果无引用 → 删除 `ToolCallLog.tsx` 和 `ToolCallLog.css`
3. 如果有引用 → 评估是否可以用 `ExecutionLog` 替代

### 涉及文件

| 操作 | 文件 |
|:---:|:---|
| DELETE? | `src/renderer/src/components/chat/ToolCallLog.tsx` |
| DELETE? | `src/renderer/src/components/chat/ToolCallLog.css` |

---

## P3-2：清理疑似弃用的 ThinkingBlock（原问题 #10）

**验证步骤：**

1. 全项目搜索 `ThinkingBlock` 的导入/引用
2. 如果无引用 → 删除 `ThinkingBlock.tsx` 和 `ThinkingBlock.css`
3. 如果有引用 → 确认是否与 ExecutionLog 的 reasoning 展示功能重复

### 涉及文件

| 操作 | 文件 |
|:---:|:---|
| DELETE? | `src/renderer/src/components/chat/ThinkingBlock.tsx` |
| DELETE? | `src/renderer/src/components/chat/ThinkingBlock.css` |

---

## P3-3：消除 `any` 类型泛滥（原问题 #11）

**改造范围：**

| 文件 | 当前 | 目标 |
|:---|:---|:---|
| `ChatArea.tsx` | `messages: any[]` | `messages: ChatMessage[]` |
| `ChatArea.tsx` | `msg.toolCalls` 多处 `any` | 使用 `ToolCallState` |
| `ExecutionLogUtils.ts` | `(item as any).content` | 使用联合类型判断 |
| `MessageParser.ts` | `(window as any).api` | 声明全局类型或使用已有的 `window.api` 类型 |

**注意：** 此项改动面广但风险低（纯类型层面），可作为独立 PR 提交。

### 涉及文件

| 操作 | 文件 |
|:---:|:---|
| MODIFY | `src/renderer/src/components/chat/ChatArea.tsx` |
| MODIFY | `src/renderer/src/components/chat/ExecutionLogUtils.ts` |
| MODIFY | `src/renderer/src/components/chat/MessageParser.ts` |
| NEW（可选） | `src/renderer/src/types/window.d.ts`（全局类型声明） |

---

## P3-4：滚动阈值硬编码（原问题 #15）

**当前代码：**

```typescript
const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150
```

**改造方案：**

```typescript
const SCROLL_BOTTOM_RATIO = 0.15
const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight
  < Math.max(container.clientHeight * SCROLL_BOTTOM_RATIO, 100)
```

使用视口高度的 15% 作为阈值，最小 100px。

### 涉及文件

| 操作 | 文件 |
|:---:|:---|
| MODIFY | `src/renderer/src/components/chat/ChatArea.tsx` |

---

## P3-5：ExecutionLog timeline 列表高度限制（原问题 #17）

**当前：** 固定 `max-height: 300px`。

**改造方案：**

```css
.timeline-list {
  /* 基于视口高度动态计算，最大不超过视口的 40% */
  max-height: min(300px, 40vh);
  overflow-y: auto;
}
```

或提供 "查看全部" 按钮，点击后移除高度限制。

### 涉及文件

| 操作 | 文件 |
|:---:|:---|
| MODIFY | `src/renderer/src/components/chat/ExecutionLog.css` |
| MODIFY（可选） | `src/renderer/src/components/chat/ExecutionLog.tsx`（添加"查看全部"按钮） |

---

## P3-6：连续 Agent 消息重复头像（原问题 #18）

**当前问题：** 每条 Agent 消息都显示 AI 头像，连续多条时视觉冗余。

**改造方案：**

在 `ChatArea.tsx` 的 `messages.map()` 中判断前一条消息是否同角色：

```typescript
const prevMsg = idx > 0 ? messages[idx - 1] : null
const showAvatar = msg.role !== prevMsg?.role

// 渲染时
{showAvatar ? (
  <Flex className="agent-avatar"><AgentAvatarIcon /></Flex>
) : (
  <div className="agent-avatar-placeholder" /> // 占位，保持对齐
)}
```

```css
.agent-avatar-placeholder {
  width: 32px;
  flex-shrink: 0;
  margin-right: 16px;
}
```

### 涉及文件

| 操作 | 文件 |
|:---:|:---|
| MODIFY | `src/renderer/src/components/chat/ChatArea.tsx` |
| MODIFY | `src/renderer/src/App.css` |

---

## P3-7：Markdown 嵌套列表支持（原问题 #21）

**当前问题：** 列表解析为扁平结构，缩进仅通过 padding 模拟。

**改造方案（增量）：**

不做完整的递归嵌套（复杂度太高），而是增加层级标记变化：

```typescript
// MessageBody.tsx — renderListBlock 中
const level = Math.floor(indent / 2)  // 每 2 空格一层
const bullets = ['•', '◦', '▪', '▸']  // 不同层级不同符号
const bullet = isOrdered ? `${num}.` : bullets[level % bullets.length]
```

这样虽然 HTML 结构仍是扁平的，但视觉上能区分嵌套层级。

### 涉及文件

| 操作 | 文件 |
|:---:|:---|
| MODIFY | `src/renderer/src/components/chat/MessageBody.tsx` |

---
---

# 各轮次概览

| 轮次 | 优先级 | 问题数 | 核心改动 | 预计工作量 |
|:---:|:---:|:---:|:---|:---:|
| 第一轮 | **P0** | 4 + 2 bug | 性能修复 + 重复逻辑提取 + Markdown 补全 | 中 |
| 第二轮 | **P1** | 4 | ChatArea 拆分 + CodeBlock 语法高亮 | 中-大 |
| 第三轮 | **P2** | 7 (3已完成) | UX 细节 + 规范一致性 | 小-中 |
| 第四轮 | **P3** | 9 (含可选) | 清洁度 + 健壮性 + 微调 | 小 |
