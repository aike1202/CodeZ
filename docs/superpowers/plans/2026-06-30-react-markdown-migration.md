# React-Markdown 重构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用 `react-markdown` 彻底替换自定义的简陋 Markdown 解析逻辑，提供标准富文本渲染能力并兼容历史行内交互设计。

**Architecture:** 
抛弃原有的基于正则的块级解析逻辑 (`parseMarkdownBlocks`)。在 `MessageBody.tsx` 中直接渲染 `<ReactMarkdown>`，并通过 `remark-gfm` 插件支持扩展语法。利用 `react-markdown` 的 `components` 属性劫持渲染：将代码块映射至我们的 `<CodeBlock>` 组件，将表格结构映射至带有对应 CSS 类的原生 HTML，并将所有的文本叶子节点 (`p`, `li`, `td`, `th`) 的内部字符串进行拦截，传入现有的 `parseInline` 工具集，以兼容保留如 "/command" 和 "文件点击" 等定制业务能力。

**Tech Stack:** React, react-markdown, remark-gfm, typescript

## Global Constraints

- 不可引入额外的体积过大解析库，仅使用 `react-markdown` 及官方推荐生态插件 `remark-gfm`。
- 不得破坏现有打字机光标（`▊`）和流式输出的行为。
- 对于所有的段落、列表、表格内容，必须确保在经过 `react-markdown` 解析后，能二次经过 `parseInline` 以渲染定制行内组件。

---

### Task 1: 环境依赖安装与初始化

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: NPM registry
- Produces: Installed dependencies (`react-markdown`, `remark-gfm`) ready for import

- [ ] **Step 1: 执行 npm 安装命令**

```bash
npm install react-markdown remark-gfm
```
Expected: PASS

- [ ] **Step 2: 验证依赖已安装**

Run: `npm list react-markdown`
Expected: PASS with version tree showing react-markdown

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install react-markdown and remark-gfm"
```

---

### Task 2: 编写辅助函数 `processInlineNodes`

**Files:**
- Modify: `src/renderer/src/components/chat/MessageBody.tsx`

**Interfaces:**
- Consumes: `parseInline` from `./MessageParser`
- Produces: A React helper function `processInlineNodes(children: React.ReactNode, validFiles?: Set<string>, showCursor?: boolean): React.ReactNode`

- [ ] **Step 1: 编写处理函数实现**

在 `MessageBody.tsx` 组件内部或外部定义一个递归处理节点内容的函数，使得所有的 `string` 子节点都能进入 `parseInline` 处理流程。

```tsx
function processInlineNodes(node: React.ReactNode, validFiles?: Set<string>, showCursor = false): React.ReactNode {
  if (typeof node === 'string') {
    return parseInline(node, () => {}, showCursor, validFiles);
  }
  if (Array.isArray(node)) {
    return node.map((child, idx) => <React.Fragment key={idx}>{processInlineNodes(child, validFiles, showCursor && idx === node.length - 1)}</React.Fragment>);
  }
  return node;
}
```
*注：这里的 onFileClick 需要动态传入，因此该逻辑最终应该写在组件主体或作为接收回调的 Hook/HOC。*

- [ ] **Step 2: 编译测试辅助函数**

Run: `npx tsc --noEmit`
Expected: PASS (如果暂未完全引用，至少无语法报错)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/chat/MessageBody.tsx
git commit -m "feat: add processInlineNodes helper in MessageBody"
```

---

### Task 3: 整体重构 `MessageBody` 组件的渲染层

**Files:**
- Modify: `src/renderer/src/components/chat/MessageBody.tsx`

**Interfaces:**
- Consumes: `<ReactMarkdown>`, `remarkGfm`
- Produces: Fully functional `MessageBody` dropping old parsing functions

- [ ] **Step 1: 删除旧有实现，引入 ReactMarkdown**

用以下结构整体替换现有的 `blocks.map` 渲染：

```tsx
// 引入依赖
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// 移除 import parseMarkdownBlocks
import { parseInline } from './MessageParser';

// 组件主体中：
export default function MessageBody({ content, streaming, reasoning, onFileClick }: /* props */) {
  const validFiles = useWorkspaceStore((s) => s.validFiles);

  // 辅助函数，将子节点中的纯字符串丢给 parseInline，其余保留
  const renderInline = (children: React.ReactNode, showCursor = false) => {
    if (typeof children === 'string') return parseInline(children, onFileClick, showCursor, validFiles);
    if (Array.isArray(children)) {
      return children.map((c, i) => (
        <React.Fragment key={i}>
          {typeof c === 'string' 
            ? parseInline(c, onFileClick, showCursor && i === children.length - 1, validFiles)
            : c}
        </React.Fragment>
      ));
    }
    return children;
  };

  // 打字机光标标记：在末尾追加不可见的标识字符
  const renderContent = streaming && !content ? '▊' : content + (streaming ? ' __STREAMING__ ' : '');

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 代码块与行内代码
          code({ node, inline, className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const isLast = streaming && String(children).includes('__STREAMING__');
            const cleanText = String(children).replace(' __STREAMING__ ', '');

            if (!inline && match) {
              return <CodeBlock lang={match[1]} code={cleanText} showCursor={isLast} />;
            } else if (!inline) {
              // 补充处理无语言标记的代码块
              return <CodeBlock lang="text" code={cleanText} showCursor={isLast} />;
            }
            return <code className="inline-code" {...props}>{cleanText}</code>;
          },
          // 标题劫持
          h1: ({ children }) => <h1 className="msg-h1">{renderInline(children)}</h1>,
          h2: ({ children }) => <h2 className="msg-h2">{renderInline(children)}</h2>,
          h3: ({ children }) => <h3 className="msg-h3">{renderInline(children)}</h3>,
          h4: ({ children }) => <h4 className="msg-h3" style={{ fontSize: '15px' }}>{renderInline(children)}</h4>,
          // 表格劫持
          table: ({ children }) => <div className="msg-table-wrapper"><table className="msg-table">{children}</table></div>,
          thead: ({ children }) => <thead className="msg-table-thead">{children}</thead>,
          tbody: ({ children }) => <tbody className="msg-table-tbody">{children}</tbody>,
          th: ({ children }) => <th className="msg-table-th">{renderInline(children)}</th>,
          td: ({ children }) => <td className="msg-table-td">{renderInline(children)}</td>,
          // 文本劫持
          p: ({ children }) => {
            const isLast = streaming && String(children).includes('__STREAMING__');
            const cleanChildren = React.Children.map(children, child => 
              typeof child === 'string' ? child.replace(' __STREAMING__ ', '') : child
            );
            return <p className="msg-p">{renderInline(cleanChildren, isLast)}</p>;
          },
          li: ({ children }) => {
             const isLast = streaming && String(children).includes('__STREAMING__');
             const cleanChildren = React.Children.map(children, child => 
               typeof child === 'string' ? child.replace(' __STREAMING__ ', '') : child
             );
             return <li>{renderInline(cleanChildren, isLast)}</li>;
          }
        }}
      >
        {renderContent}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 编译检查验证类型正确性**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/chat/MessageBody.tsx
git commit -m "refactor: replace custom markdown parser with react-markdown"
```

---

### Task 4: 移除旧冗余代码 `parseMarkdownBlocks` 及其遗留依赖

**Files:**
- Modify: `src/renderer/src/components/chat/MessageParser.ts`

**Interfaces:**
- Removes: `parseMarkdownBlocks` and `MarkdownBlock` interfaces
- Produces: Cleaner MessageParser file

- [ ] **Step 1: 删除 `parseMarkdownBlocks` 和 `MarkdownBlock` 的相关定义代码**

编辑 `MessageParser.ts`，彻底移除这部分：
```typescript
export interface MarkdownBlock { ... }
export function parseMarkdownBlocks(text: string): MarkdownBlock[] { ... }
```

- [ ] **Step 2: TypeScript 编译验证**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/chat/MessageParser.ts
git commit -m "refactor: remove deprecated parseMarkdownBlocks"
```
