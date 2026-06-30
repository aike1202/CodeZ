# React-Markdown 重构设计文档

**日期：** 2026-06-30  
**范围：** `src/renderer/src/components/chat/MessageBody.tsx` 及关联解析模块  
**目标：** 引入 `react-markdown` 和 `remark-gfm` 彻底替换现有脆弱的自定义 Markdown 解析器，提供全量标准 Markdown 支持，同时保留原有的文件链接、命令等内联交互逻辑。

---

## 1. 架构演进与组件划分

### 1.1 现状分析
目前 `MessageBody.tsx` 依赖 `parseMarkdownBlocks`（基于正则切分行）识别 `h1-h3`, `p`, `table` 等基础块级元素，对于行内元素则依赖 `parseInline`。
- **痛点**：对于更高级的嵌套块（如列表内套代码块）、`h4-h6` 等直接无法解析，且代码膨胀难以维护。

### 1.2 目标架构
引入基于统一语法树 (AST) 的标准解析流：
```
Text (Markdown String) 
  → remark-parse (生成 Markdown AST)
  → remark-gfm (扩展支持表格、删除线等)
  → react-markdown (渲染为 React Components)
```

我们将完全废弃 `parseMarkdownBlocks` 函数，重写 `MessageBody.tsx` 组件，并大幅精简代码。

---

## 2. 核心组件映射与数据流

`react-markdown` 的精髓在于可以通过 `components` 属性劫持任何 HTML 标签的渲染。我们将进行以下核心映射：

### 2.1 块级组件映射 (Block Level)
- **`code` (代码块与行内代码)**：
  如果 `code` 的 `inline` 为 `false` 且带有语言标记 `className`（例如 `language-ts`），我们将它劫持并渲染为现有的 `<CodeBlock>` 组件。
  这里也是后续实施 P1-3 (CodeBlock 引入 highlight.js) 的绝佳切入点。
- **`table`, `th`, `td`**：
  直接映射到我们现有的类名（如 `msg-table`, `msg-table-th`, `msg-table-td`），完美复用已有的 `MessageBody.css` 样式。

### 2.2 行内组件的兼容策略 (Inline Level)
如何保留我们原有的“点击文件跳转”、“点击 `/命令` 插入”等功能是本次重构的难点。
**解决方案**：劫持可能会包含文本的叶子节点组件（主要是 `p`, `li`, `td`, `th`），对于其中的字符串子节点，继续使用我们重构过的 `parseInline(string, validFiles, ...)` 进行处理。

```typescript
// 伪代码示例：
components={{
  p: ({ children }) => {
    // 递归遍历 children，将其中的纯字符串部分交给 parseInline 处理
    const processedChildren = processChildrenWithParseInline(children, validFiles);
    return <p className="msg-p">{processedChildren}</p>;
  }
}}
```

### 2.3 Streaming 打字机光标的兼容
原本的光标 `▊` 是在 `parseMarkdownBlocks` 判定为最后一个块且流式输出时手动 push 到节点的。
在 `react-markdown` 下，我们可以通过在传入的 `content` 字符串末尾自动追加一个零宽字符或特定的特殊标记字符串（如 `__STREAMING_CURSOR__`），并在映射时替换成带有动画的 `▊` 组件。

---

## 3. 依赖管理

执行重构前，需要通过 npm 安装如下库：
- `react-markdown`
- `remark-gfm`

---

## 4. 影响范围与测试计划

**受影响模块**：仅影响 `MessageBody.tsx` 和相关解析。不会影响 API 请求、工具调用执行等核心主流程。
**测试点**：
1. `####` 四级以上标题必须被正确渲染放大。
2. 表格必须被正确渲染且不会撑爆容器。
3. 对话中包含文件路径（如 `src/App.tsx`）依然能高亮并支持点击触发 Diff/代码预览。
4. 模型流式输出时，光标应该跟随在段落末尾自然跳动。
