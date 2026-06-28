# AI Coding Agent 工具系统设计笔记

本文档用于梳理 AI Coding Agent 中工具系统的设计，重点关注文件读取、创建、写入、长文件处理、精准编辑、Diff/Patch、权限和用户体验。当前项目已经实现部分基础工具，后续可以按本文逐步优化。

## 1. 工具系统的目标

工具系统不是简单把本地能力暴露给模型，而是要让模型在可控、安全、可验证的边界内完成编码任务。

核心目标：

- 让 Agent 能真实读取项目，而不是猜测。
- 让 Agent 能小步、精准地修改文件。
- 避免长文件全量覆盖导致误删或冲突。
- 支持大文件分段读取和必要时分块写入。
- 支持 Diff / Patch 形式的代码编辑。
- 支持权限控制、审批、回滚和变更预览。
- 支持工具失败后的可恢复流程。

推荐原则：

- 读文件要支持行号、分页、截断提示。
- 改已有代码优先用 Patch 或精准替换。
- 创建新文件可以用全量写入。
- 覆盖已有文件要谨慎，最好带 hash 校验。
- 长文件不要让模型一次性重写。
- 所有工具结果都必须真实返回给模型。

## 2. 工具分层

建议将工具按风险和用途分层：

| 层级 | 工具类型 | 风险 | 用途 |
| --- | --- | --- | --- |
| L1 | 只读工具 | 低 | 搜索、读取、列目录、查看 Git 状态。 |
| L2 | 局部编辑工具 | 中 | 替换文本、替换行范围、应用 Patch。 |
| L3 | 文件写入工具 | 中高 | 创建文件、覆盖文件、分块写入。 |
| L4 | 命令执行工具 | 高 | Shell、测试、构建、安装依赖。 |
| L5 | 外部系统工具 | 高 | MCP、浏览器、GitHub、数据库、网络。 |

Coding Agent 的常规编辑路径应该是：

```text
search / read
→ understand
→ patch / replace
→ validate
→ summarize
```

而不是：

```text
read whole file
→ rewrite whole file
```

## 3. 读取类工具

### 3.1 `read_file`

用于读取文件内容。必须支持长文件分段读取。

推荐 Schema：

```ts
type ReadFileTool = {
  name: "read_file";
  description: "Read a file with optional line range pagination.";
  input: {
    path: string;
    offset?: number;
    limit?: number;
  };
  output: {
    path: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    truncated: boolean;
    content: string;
    sha256?: string;
  };
};
```

设计要点：

- `offset` 建议用 1-based 行号。
- `limit` 表示最多读取多少行。
- 默认读取前 200-300 行，避免超大文件撑爆上下文。
- 返回 `totalLines` 和 `truncated`，让模型知道是否还有未读内容。
- 返回行号，方便后续 `replace_range` 或 Patch 定位。
- 返回 `sha256`，用于后续写入时做并发/陈旧内容校验。

示例输出：

```json
{
  "path": "src/app.ts",
  "startLine": 1,
  "endLine": 200,
  "totalLines": 850,
  "truncated": true,
  "content": "...",
  "sha256": "abc123"
}
```

### 3.2 `list_files`

用于列出目录内容。

```ts
type ListFilesTool = {
  name: "list_files";
  input: {
    path: string;
    recursive?: boolean;
    maxEntries?: number;
    includeHidden?: boolean;
  };
  output: {
    entries: Array<{
      path: string;
      type: "file" | "directory";
      size?: number;
    }>;
    truncated: boolean;
  };
};
```

建议：

- 默认不递归。
- 递归时必须限制 `maxEntries`。
- 自动忽略 `node_modules`、`.git`、`dist`、`build` 等目录，除非用户明确要求。

### 3.3 `search_text`

用于搜索文本，类似 `rg`。

```ts
type SearchTextTool = {
  name: "search_text";
  input: {
    query: string;
    path?: string;
    glob?: string;
    caseSensitive?: boolean;
    maxResults?: number;
  };
  output: {
    results: Array<{
      path: string;
      line: number;
      preview: string;
    }>;
    truncated: boolean;
  };
};
```

建议：

- 搜索结果必须带路径、行号和预览。
- 默认限制结果数量，例如 50 条。
- 超出时返回 `truncated: true`，提示模型缩小搜索范围。

## 4. 创建与写入工具

### 4.1 `create_file`

用于创建新文件。

```ts
type CreateFileTool = {
  name: "create_file";
  description: "Create a new file. Fails if the file already exists unless explicitly allowed.";
  input: {
    path: string;
    content: string;
    overwrite?: false;
  };
};
```

设计要点：

- 默认只能创建不存在的文件。
- 如果文件已存在，必须失败。
- 不建议用它覆盖已有代码。
- 适合创建文档、测试文件、配置文件、小型源码文件。

### 4.2 `write_file`

用于完整写入文件。风险高于 `create_file`。

```ts
type WriteFileTool = {
  name: "write_file";
  description: "Write full file content, preferably for new or small files.";
  input: {
    path: string;
    content: string;
    createIfMissing?: boolean;
    overwrite?: boolean;
    expectedHash?: string;
  };
};
```

设计要点：

- 已存在文件默认不允许覆盖，除非 `overwrite: true`。
- 覆盖已有文件时应要求 `expectedHash`。
- 如果当前文件 hash 与 `expectedHash` 不一致，应失败。
- 不建议用于已有长代码文件。
- 适合小型配置、生成文档、测试 fixture。

### 4.3 `begin_file_write` / `append_file_chunk` / `finish_file_write`

用于长文件分块写入。这个能力主要适合生成新长文件，不适合编辑已有代码文件。

```ts
type BeginFileWriteTool = {
  name: "begin_file_write";
  input: {
    path: string;
    mode: "create" | "overwrite";
    expectedHash?: string;
  };
  output: {
    writeId: string;
  };
};

type AppendFileChunkTool = {
  name: "append_file_chunk";
  input: {
    writeId: string;
    index: number;
    chunk: string;
  };
};

type FinishFileWriteTool = {
  name: "finish_file_write";
  input: {
    writeId: string;
    expectedChunks?: number;
    finalHash?: string;
  };
};
```

设计要点：

- `begin_file_write` 创建临时写入会话，不直接覆盖目标文件。
- `append_file_chunk` 按序写入 chunk。
- `finish_file_write` 校验 chunk 数量和最终 hash 后再原子替换目标文件。
- 写入期间失败时，应能自动清理临时文件。
- 分块写入需要防止乱序、重复 chunk、漏 chunk。
- 对已有文件 overwrite 时必须使用 `expectedHash`。

推荐流程：

```text
begin_file_write
→ append_file_chunk(index=0)
→ append_file_chunk(index=1)
→ append_file_chunk(index=2)
→ finish_file_write
```

不推荐流程：

```text
读取已有 2000 行代码
→ 模型重新生成 2000 行
→ 分块覆盖整个文件
```

这种方式很容易丢失细节，应该改用 Patch。

## 5. 精准编辑工具

### 5.1 `replace_text`

用于将文件中的精确文本片段替换为新文本。

```ts
type ReplaceTextTool = {
  name: "replace_text";
  description: "Replace an exact text snippet in a file.";
  input: {
    path: string;
    oldText: string;
    newText: string;
    expectedOccurrences?: number;
    expectedHash?: string;
  };
};
```

设计要点：

- `oldText` 必须精确匹配。
- 默认 `expectedOccurrences` 为 1。
- 匹配 0 次或多次时必须失败。
- 失败后 Agent 应重新读取上下文，不应盲目重试。
- 适合小范围、上下文明确的修改。

### 5.2 `replace_range`

用于根据行号替换指定范围。

```ts
type ReplaceRangeTool = {
  name: "replace_range";
  description: "Replace a line range, guarded by expected text or file hash.";
  input: {
    path: string;
    startLine: number;
    endLine: number;
    newText: string;
    expectedText?: string;
    expectedHash?: string;
  };
};
```

设计要点：

- 行号建议使用 1-based。
- 最好要求 `expectedText` 或 `expectedHash`。
- 如果指定范围内容和 `expectedText` 不一致，应失败。
- 用户在编辑器中选中代码后触发 AI 修改时，这个工具非常适合。
- 纯行号替换有风险，因为文件可能已变化。

### 5.3 `insert_before` / `insert_after`

用于在锚点附近插入内容。

```ts
type InsertAroundTool = {
  name: "insert_before" | "insert_after";
  input: {
    path: string;
    anchorText: string;
    content: string;
    expectedOccurrences?: number;
    expectedHash?: string;
  };
};
```

设计要点：

- `anchorText` 必须唯一。
- 如果锚点不唯一，工具失败。
- 适合添加 import、注册路由、追加测试用例。

## 6. Diff / Patch 工具

### 6.1 `apply_patch`

Patch 是 Coding Agent 修改已有代码最推荐的方式。

```ts
type ApplyPatchTool = {
  name: "apply_patch";
  description: "Apply a unified diff patch to workspace files.";
  input: {
    patch: string;
    expectedHashByPath?: Record<string, string>;
  };
  output: {
    changedFiles: string[];
    summary: string;
  };
};
```

推荐 Patch 格式：

```diff
*** Begin Patch
*** Update File: src/login.ts
@@
- submit()
+ await submit()
*** End Patch
```

设计要点：

- Patch 应只修改必要代码。
- Patch 失败时返回明确错误，例如上下文不匹配。
- Patch 失败后 Agent 应重新读取相关文件。
- Patch 前可选 `expectedHashByPath`，防止基于旧文件修改。
- Patch 应支持新增文件、修改文件、删除文件，但删除文件应需要更高权限或确认。

### 6.2 为什么 Patch 优于全量写入

Patch 的优势：

- 上下文少，节省 token。
- 修改范围清晰。
- 更容易 review。
- 更少误删风险。
- 更适合已有代码文件。
- 与 Git diff 心智模型一致。

全量写入的问题：

- 容易覆盖用户未保存或其他 Agent 的修改。
- 长文件容易丢失细节。
- 模型可能重排无关代码。
- Review 成本高。

### 6.3 Patch 失败处理

Patch 失败时不要让 Agent 反复猜。推荐失败响应包含：

```json
{
  "error": "patch context mismatch",
  "file": "src/login.ts",
  "hint": "The target file changed or the context is incomplete. Re-read the relevant range."
}
```

Agent 恢复流程：

```text
Patch failed
→ read_file 读取相关区域
→ 重新定位上下文
→ 生成更小 Patch
→ 再次 apply_patch
```

## 7. 工具权限与安全

工具系统必须有 Runtime 级权限控制，不能只依赖 Prompt。

建议规则：

| 行为 | 默认策略 |
| --- | --- |
| 读取 workspace 内文件 | 允许。 |
| 写入 workspace 内文件 | 允许或需要用户确认，取决于模式。 |
| 写入 workspace 外文件 | 默认禁止或审批。 |
| 删除文件 | 默认审批。 |
| 覆盖已有文件 | 需要 `expectedHash` 或用户确认。 |
| 运行测试/构建 | 通常允许。 |
| 安装依赖 | 需要审批。 |
| 联网访问 | 需要审批或配置白名单。 |
| MCP / 插件调用 | 走同一套权限系统。 |

建议每个工具都返回结构化结果：

```ts
type ToolResult<T> = {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
    suggestion?: string;
  };
};
```

## 8. 用户体验建议

### 8.1 修改前预览

对高风险修改，可以先生成 preview：

```ts
type PreviewPatchTool = {
  name: "preview_patch";
  input: {
    patch: string;
  };
  output: {
    diff: string;
    affectedFiles: string[];
    riskLevel: "low" | "medium" | "high";
  };
};
```

然后用户确认后再 `apply_patch`。

### 8.2 工具调用前说明

Agent 在调用工具前应给用户简短说明，例如：

```text
我先搜索登录相关代码，定位提交逻辑。
```

不要每读一个小文件都啰嗦，但一组操作前最好说明意图。

### 8.3 编辑器集成

如果你的项目有编辑器 UI，可以提供：

- 用户选区 → `replace_range`。
- 当前文件 → `read_file`。
- 当前诊断 → 注入 Prompt。
- Diff 面板 → `preview_patch`。
- 接受/拒绝单个 hunk。
- 回滚本轮修改。

## 9. 工具选择策略

推荐让模型遵循以下策略：

```text
如果只是理解代码：使用 search_text / read_file。
如果创建新小文件：使用 create_file。
如果创建新长文件：使用 begin_file_write + append_file_chunk + finish_file_write。
如果修改已有代码：优先 apply_patch。
如果是小范围唯一文本替换：可用 replace_text。
如果用户选中了一段代码：可用 replace_range。
如果需要验证：使用 shell 运行最相关测试。
```

不推荐：

```text
用 write_file 覆盖已有长源码文件。
用 replace_range 但不校验 expectedText。
Patch 失败后不重新读取文件就反复尝试。
工具失败后假装成功。
```

## 10. 当前项目的优化顺序

如果你已经实现了读取、创建、写入，建议下一步按这个顺序优化：

1. `read_file` 增加 `offset`、`limit`、`totalLines`、`truncated`、行号返回。
2. `write_file` 增加 `expectedHash`，避免覆盖旧版本。
3. 新增 `replace_text`，用于唯一片段替换。
4. 新增 `replace_range`，支持用户选区编辑。
5. 新增 `apply_patch`，作为修改已有代码的主路径。
6. 新增 Patch 失败后的错误结构和恢复建议。
7. 新增 `preview_patch`，在 UI 中展示 Diff。
8. 新增分块写入工具，专门用于创建新长文件。
9. 给所有写入类工具接入权限和审批。
10. 将工具结果统一成 `ToolResult<T>`。

## 11. 推荐最小工具集

如果先做 MVP，推荐至少实现：

```text
list_files
search_text
read_file
create_file
replace_text
apply_patch
shell
```

其中 `apply_patch` 是最关键的编辑工具，`replace_text` 是实现成本较低但体验很好的过渡工具。

## 12. 总结

AI Coding Agent 的工具系统应围绕“可定位、可小步修改、可验证、可恢复”来设计。

最重要的判断是：

- 新文件：可以创建或分块写入。
- 小文件：可以完整写入，但最好带 hash。
- 已有代码文件：优先 Patch。
- 用户选区：优先 range replace。
- 长文件：分页读取，不全量重写。
- 高风险操作：预览、审批、可回滚。

## 13. 代码检索工具

代码检索是 AI Coding Agent 能力上限的关键因素。模型本身无法真实“知道”项目结构，必须依赖检索工具把相关代码、配置、测试和文档找出来。检索能力越好，Agent 越不容易幻觉，定位问题越快，修改越精准。

### 13.1 检索工具的目标

代码检索工具应解决几个问题：

- 快速找到符号、函数、类、接口、组件、路由、配置。
- 快速定位调用链和引用关系。
- 支持关键词检索、文件名检索、语义检索、结构化符号检索。
- 支持大项目下的结果排序和截断。
- 返回足够上下文，但不能一次塞入过多内容。
- 让 Agent 能从“猜文件”变成“查证文件”。

推荐检索路径：

```text
用户问题
→ 提取关键词 / 符号 / 文件线索
→ 文件名检索
→ 文本检索
→ 符号检索
→ 引用/调用检索
→ 读取相关片段
→ 必要时语义检索补充
```

### 13.2 基础检索工具

#### `search_text`

用于全文关键词搜索，类似 `rg`。

```ts
type SearchTextTool = {
  name: "search_text";
  description: "Search text in workspace files. Prefer this before reading broad files.";
  input: {
    query: string;
    path?: string;
    glob?: string;
    caseSensitive?: boolean;
    maxResults?: number;
    contextLines?: number;
  };
  output: {
    results: Array<{
      path: string;
      line: number;
      column?: number;
      preview: string;
      before?: string[];
      after?: string[];
    }>;
    truncated: boolean;
  };
};
```

设计建议：

- 默认 `maxResults` 设为 50。
- 默认 `contextLines` 设为 0-2。
- 返回路径、行号、列号、预览。
- 结果过多时提示模型缩小搜索范围。
- 自动忽略 `node_modules`、`.git`、`dist`、`build`、缓存目录。

#### `find_files`

用于按文件名或 glob 找文件。

```ts
type FindFilesTool = {
  name: "find_files";
  description: "Find files by name, extension, or glob.";
  input: {
    query?: string;
    glob?: string;
    path?: string;
    maxResults?: number;
  };
  output: {
    files: Array<{
      path: string;
      size: number;
      modifiedAt?: string;
    }>;
    truncated: boolean;
  };
};
```

适用场景：

- 找 `Login.tsx`、`auth.ts`、`router.ts`。
- 找所有测试文件。
- 找配置文件，例如 `vite.config.ts`、`package.json`。

### 13.3 符号检索

纯文本搜索不够，代码 Agent 最好支持符号级检索。

#### `search_symbols`

```ts
type SearchSymbolsTool = {
  name: "search_symbols";
  description: "Search code symbols such as functions, classes, types, variables, components, and methods.";
  input: {
    query: string;
    kind?: "function" | "class" | "interface" | "type" | "variable" | "component" | "method";
    path?: string;
    maxResults?: number;
  };
  output: {
    symbols: Array<{
      name: string;
      kind: string;
      path: string;
      startLine: number;
      endLine: number;
      signature?: string;
      exportType?: "default" | "named" | "none";
    }>;
    truncated: boolean;
  };
};
```

实现方式：

- TypeScript / JavaScript：可用 TypeScript compiler API、tsserver、tree-sitter。
- Python：可用 AST。
- Kotlin / Java：可用 LSP、tree-sitter 或语言服务。
- 多语言项目：优先接 LSP，再用 tree-sitter 兜底。

价值：

- 搜 `login` 时能区分函数、组件、类型和变量。
- 能直接定位定义范围，方便 `read_file` 精读。
- 比纯文本搜索更少噪音。

### 13.4 引用与调用链检索

#### `find_references`

```ts
type FindReferencesTool = {
  name: "find_references";
  description: "Find references to a symbol.";
  input: {
    symbol: string;
    path?: string;
    line?: number;
    column?: number;
    maxResults?: number;
  };
  output: {
    references: Array<{
      path: string;
      line: number;
      column?: number;
      preview: string;
      referenceKind?: "read" | "write" | "call" | "import" | "export";
    }>;
    truncated: boolean;
  };
};
```

用途：

- 修改函数签名前，找所有调用方。
- 删除变量前，确认没有引用。
- 排查状态在哪里被写入。
- 理解一个 API 的影响范围。

#### `find_definition`

```ts
type FindDefinitionTool = {
  name: "find_definition";
  description: "Find the definition of a symbol at a given file position.";
  input: {
    path: string;
    line: number;
    column: number;
  };
  output: {
    definitions: Array<{
      path: string;
      startLine: number;
      endLine: number;
      name: string;
      kind: string;
      signature?: string;
    }>;
  };
};
```

实现建议：

- 如果接入 LSP，优先使用 LSP 的 definition / references。
- 如果没有 LSP，可以先用文本检索和符号索引近似实现。
- 对动态语言不要假装 100% 准确，结果里可以返回 `confidence`。

### 13.5 语义检索

关键词和符号检索适合“知道名字”的场景。语义检索适合用户只描述功能、不知道代码位置的场景。

#### `semantic_search`

```ts
type SemanticSearchTool = {
  name: "semantic_search";
  description: "Search code semantically by natural language intent.";
  input: {
    query: string;
    path?: string;
    topK?: number;
    fileTypes?: string[];
  };
  output: {
    results: Array<{
      path: string;
      startLine: number;
      endLine: number;
      score: number;
      summary: string;
      snippet: string;
    }>;
  };
};
```

适用场景：

- “支付成功后跳转在哪里处理？”
- “哪个地方负责刷新用户信息？”
- “错误 toast 是在哪里统一封装的？”
- “找一下和会话持久化相关的代码。”

注意：

- 语义检索结果必须再用 `read_file` 验证。
- 不要把语义检索当成事实来源。
- 语义检索适合召回，符号/文本检索适合确认。

### 13.6 代码索引

为了提升检索速度和质量，建议 Runtime 维护代码索引。

索引内容：

- 文件路径、大小、mtime、hash。
- 文件语言类型。
- imports / exports。
- 函数、类、接口、类型、组件。
- 符号定义范围。
- 引用关系。
- 测试文件和源文件映射。
- 路由、命令、配置入口。
- 文档摘要。
- 可选：代码块 embedding。

索引数据模型示例：

```ts
type CodeIndexFile = {
  path: string;
  language: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  symbols: CodeSymbol[];
  imports: string[];
  exports: string[];
  summary?: string;
};

type CodeSymbol = {
  name: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  signature?: string;
  exported?: boolean;
};
```

索引更新策略：

- 启动时增量扫描 workspace。
- 文件变更时按 hash / mtime 增量更新。
- 大目录和忽略目录不索引。
- embedding 可以异步生成，不阻塞基础检索。
- 如果索引过期，工具结果应标记 `stale: true` 或触发刷新。

### 13.7 检索结果排序

检索结果排序直接影响 Agent 表现。建议综合以下因素：

- 文件名是否匹配 query。
- 符号名是否匹配 query。
- 路径是否在常见源码目录，例如 `src`、`app`、`lib`。
- 是否是测试文件。
- 是否是导出符号。
- 最近修改时间。
- 文本匹配密度。
- 语义相似度分数。
- 是否被其他文件频繁引用。

可以返回 `score` 和 `reason`：

```json
{
  "path": "src/features/auth/LoginForm.tsx",
  "line": 42,
  "score": 0.92,
  "reason": "file name and exported component match login form query"
}
```

### 13.8 检索工具与 Prompt 的配合

Developer Prompt 中建议加入：

```text
Code search rules:
- Do not guess file locations. Use find_files, search_text, or search_symbols first.
- Use semantic_search when the user describes behavior but does not name symbols.
- Treat semantic_search as recall only; verify results with read_file.
- Before editing a symbol, inspect its definition and relevant references.
- If search results are too broad, refine the query instead of reading many files.
```

Shell 规则中建议加入：

```text
Use dedicated search tools instead of shell commands like grep, rg, find, or Get-ChildItem when search tools are available.
Shell is for tests, builds, package scripts, and commands not covered by tools.
```

这样可以避免 Agent 总是通过 Shell 搜索，而是优先使用你的结构化检索工具。

## 14. 模糊搜索与容错检索

用户经常会输错名称、少打字母、多打字母、大小写不一致，或者记错组件、函数、文件名。优秀的 Coding Agent 检索系统不能只做精确匹配，还需要支持模糊搜索和容错检索。

常见错误类型：

| 类型 | 示例 | 期望匹配 |
| --- | --- | --- |
| 少字母 | `LoginFrom` | `LoginForm` |
| 多字母 | `Userss` | `Users` / `User` |
| 大小写错误 | `loginform` | `LoginForm` |
| 分隔符错误 | `login-form` | `LoginForm.tsx` / `loginForm` |
| 单复数错误 | `users` | `user` / `UsersPage` |
| 缩写错误 | `auth cfg` | `authConfig` |
| 记错前缀 | `PaymentModal` | `CheckoutModal` |
| 只记得功能 | `刷新 token 的地方` | `refreshAccessToken` |

### 14.1 `fuzzy_search`

建议提供一个专门的模糊搜索工具，也可以将它集成到 `find_files`、`search_symbols`、`search_text` 中。

```ts
type FuzzySearchTool = {
  name: "fuzzy_search";
  description: "Fuzzy search files, symbols, and text when the query may be misspelled or incomplete.";
  input: {
    query: string;
    path?: string;
    target?: "all" | "files" | "symbols" | "text";
    maxResults?: number;
    minScore?: number;
  };
  output: {
    results: Array<{
      path: string;
      kind: "file" | "symbol" | "text";
      name?: string;
      line?: number;
      score: number;
      matchReason: string;
      preview?: string;
    }>;
    truncated: boolean;
  };
};
```

示例输出：

```json
{
  "results": [
    {
      "path": "src/features/auth/LoginForm.tsx",
      "kind": "file",
      "name": "LoginForm.tsx",
      "score": 0.91,
      "matchReason": "filename is close to LoginFrom by edit distance"
    }
  ],
  "truncated": false
}
```

### 14.2 模糊匹配算法

可以组合多种算法，而不是只靠一种：

| 算法 | 适合场景 |
| --- | --- |
| Case-insensitive match | 大小写错误。 |
| Subsequence match | 少打字符，例如 `lgform` 匹配 `LoginForm`。 |
| Levenshtein distance | 少字母、多字母、输错字母。 |
| Jaro-Winkler | 名称短、拼写相近。 |
| Tokenized matching | `login form` 匹配 `LoginForm` / `login-form`。 |
| CamelCase splitting | `LF` 匹配 `LoginForm`，`auth cfg` 匹配 `authConfig`。 |
| Stemming / singularization | `users` 匹配 `user`。 |
| Synonym map | `signin` 匹配 `login`，`auth` 匹配 `authentication`。 |
| Semantic search | 用户记得功能但不记得名字。 |

推荐组合评分：

```text
finalScore =
  filenameScore * 0.30 +
  symbolScore * 0.30 +
  textScore * 0.15 +
  pathScore * 0.10 +
  semanticScore * 0.15
```

实际权重可以按工具目标调整：

- 找文件时提高 `filenameScore`。
- 找函数/组件时提高 `symbolScore`。
- 用户描述功能时提高 `semanticScore`。

### 14.3 归一化处理

模糊搜索前建议先做 query 和候选项归一化：

```text
LoginForm.tsx → login form tsx
login-form → login form
login_form → login form
loginForm → login form
AUTH_CONFIG → auth config
users → user / users
```

归一化步骤：

1. 转小写。
2. 拆分 CamelCase。
3. 替换 `_`、`-`、`.`、`/` 为空格。
4. 移除常见扩展名权重干扰。
5. 处理单复数。
6. 应用同义词表。

同义词表示例：

```json
{
  "signin": ["login", "auth"],
  "signout": ["logout"],
  "account": ["user", "profile"],
  "payment": ["checkout", "billing"],
  "config": ["cfg", "settings", "options"]
}
```

### 14.4 检索降级策略

当精确检索没有结果时，不要直接告诉用户“找不到”。推荐自动降级：

```text
exact file search
→ exact symbol search
→ exact text search
→ case-insensitive search
→ fuzzy file/symbol search
→ semantic search
→ ask user for clarification
```

Agent 行为示例：

```text
没有找到 `LoginFrom`，我会尝试模糊搜索相近的文件和符号。
```

如果找到高置信候选：

```text
我没有找到 `LoginFrom`，但找到相近的 `LoginForm`，先检查这个组件。
```

如果多个候选接近：

```text
找到多个相近结果：`LoginForm`、`LoginPage`、`LoginFooter`。我会优先查看与提交逻辑相关的 `LoginForm`。
```

### 14.5 模糊搜索结果的风险控制

模糊搜索不能直接作为事实来源。它只负责召回候选，最终仍要读取文件确认。

规则：

- `score >= 0.85`：可以自动选中，但仍需 `read_file` 验证。
- `0.65 <= score < 0.85`：可以继续调查，但最终回复中不要说“确定”除非已读文件确认。
- `score < 0.65`：只作为候选，不应直接编辑。
- 多个候选分数接近时，优先结合路径、符号类型、引用关系判断。

工具输出建议包含 `matchReason`，让模型知道为什么匹配：

```json
{
  "name": "LoginForm",
  "score": 0.89,
  "matchReason": "query LoginFrom differs by transposed characters from LoginForm"
}
```

### 14.6 与其他检索工具的关系

推荐关系：

```text
find_files: 精确/半精确文件名检索
search_text: 精确文本检索
search_symbols: 符号级检索
fuzzy_search: 拼写错误和不完整名称检索
semantic_search: 自然语言意图检索
```

不要让 `fuzzy_search` 替代所有检索。它应该是精确检索失败后的补充，或者当用户明显输入不准确时主动使用。

### 14.7 Prompt 规则

Developer Prompt 中建议加入：

```text
Fuzzy search rules:
- If exact search has no results, try fuzzy_search before asking the user.
- Use fuzzy_search when the query looks misspelled, abbreviated, or incomplete.
- Treat fuzzy results as candidates, not facts.
- Always verify fuzzy matches with read_file before editing.
- If multiple fuzzy candidates have similar scores, inspect the most relevant one or ask a concise clarification.
```

### 14.8 MVP 实现建议

如果先做简单版本，推荐优先实现：

1. 文件名大小写不敏感匹配。
2. CamelCase / kebab-case / snake_case 归一化。
3. Levenshtein 距离匹配文件名和符号名。
4. `maxResults` + `score` + `matchReason`。
5. 精确搜索无结果时自动 fallback 到 `fuzzy_search`。
6. 后续再接入语义检索和同义词表。

这样即使用户输错 `LoginFrom`，Agent 也能找到 `LoginForm`，而不是直接失败或开始乱猜。

## 15. 单一 `search` 工具设计

如果不希望给 Agent 暴露很多功能相似的检索工具，可以只提供一个强大的 `search` 工具。对模型来说，工具越少越不容易选错；对 Runtime 来说，复杂度可以隐藏在工具内部。

推荐原则：

```text
查代码，一律用 search。
不要让 Agent 在 find_files、search_text、search_symbols、fuzzy_search、semantic_search 之间纠结。
```

内部可以融合多种能力：

- 文件名搜索。
- 全文搜索。
- 正则搜索。
- 符号搜索。
- 模糊搜索。
- 语义搜索。
- 结果排序。
- 上下文片段返回。

### 15.1 推荐 Schema

完整版本：

```ts
type SearchTool = {
  name: "search";
  description: `
Search the workspace for files, text, symbols, and approximate matches.
Use this for all codebase discovery instead of shell commands like rg, grep, find,
Get-ChildItem, Select-String, or dir.
Supports exact text, regex, fuzzy, file-name, symbol-like, and natural language queries.
`;

  input: {
    query: string;
    path?: string;
    mode?: "auto" | "text" | "regex" | "file" | "symbol" | "fuzzy" | "semantic";
    caseSensitive?: boolean;
    maxResults?: number;
    contextLines?: number;
    includeGlobs?: string[];
    excludeGlobs?: string[];
  };

  output: {
    results: Array<{
      kind: "file" | "text" | "symbol" | "fuzzy" | "semantic";
      path: string;
      line?: number;
      column?: number;
      endLine?: number;
      name?: string;
      score?: number;
      match?: string;
      preview?: string;
      before?: string[];
      after?: string[];
      reason?: string;
    }>;
    totalMatches: number;
    truncated: boolean;
    suggestions?: string[];
  };
};
```

### 15.2 简化版 Schema

更推荐先实现简单版本，让 Agent 少填参数：

```ts
type SearchTool = {
  name: "search";
  description: "Search codebase files, text, symbols, fuzzy matches, and semantic intent. Use this for all code discovery.";
  input: {
    query: string;
    path?: string;
    maxResults?: number;
  };
};
```

Runtime 内部自动判断：

- query 包含 `|`、`.*`、`\b` 等正则特征 → 尝试 regex。
- query 像文件名 → 文件名搜索。
- query 像 CamelCase / 函数名 → 符号搜索。
- query 很长、像自然语言 → 语义搜索。
- 精确搜索无结果 → 自动 fuzzy fallback。
- 结果太多 → 自动排序、截断，并返回 `suggestions`。

Agent 调用示例：

```ts
search({
  query: "设置|置设|Settings|settings|setting|gear|cog|Sidebar|HomePage|Home|openSettings|navigateToSettings",
  path: "src",
  maxResults: 100
})
```

或者：

```ts
search({
  query: "首页左下角设置按钮点击无效",
  path: "src"
})
```

### 15.3 内部实现流程

`search` 工具内部可以做多路召回：

```text
输入 query
→ query normalize
→ 判断 query 类型
→ 多路召回
   1. file name search
   2. exact text search
   3. regex text search
   4. symbol search
   5. fuzzy file/symbol search
   6. semantic search
→ 合并去重
→ 计算 score
→ 排序
→ 截断
→ 返回结构化结果
```

伪代码：

```ts
async function search(input: SearchInput): Promise<SearchOutput> {
  const normalized = normalizeQuery(input.query);

  const candidates = await Promise.all([
    searchFiles(normalized, input),
    searchText(normalized, input),
    looksLikeRegex(input.query) ? searchRegex(input.query, input) : [],
    searchSymbols(normalized, input),
    fuzzySearch(normalized, input),
    shouldUseSemantic(input.query) ? semanticSearch(input.query, input) : [],
  ]);

  return rankAndMerge(candidates.flat(), input.maxResults ?? 50);
}
```

### 15.4 返回结果格式

不要只返回纯文本：

```text
src/Home.tsx:42: Settings
```

更推荐返回结构化结果：

```json
{
  "results": [
    {
      "kind": "text",
      "path": "src/pages/Home.tsx",
      "line": 42,
      "column": 15,
      "match": "Settings",
      "preview": "<IconButton aria-label=\"Settings\" onClick={openSettings} />",
      "score": 0.94,
      "reason": "exact text match in Home page"
    }
  ],
  "totalMatches": 1,
  "truncated": false,
  "suggestions": []
}
```

关键字段：

- `kind`：告诉 Agent 这是文件、文本、符号、模糊结果还是语义结果。
- `path`：用于后续 `read_file`。
- `line` / `column`：用于定位。
- `preview`：帮助模型快速判断是否相关。
- `score`：用于排序和置信度判断。
- `reason`：解释为什么匹配。
- `truncated`：告诉模型是否需要缩小范围。
- `suggestions`：提示更好的搜索词。

### 15.5 Tool Description 约束

`search` 工具的 description 应明确告诉模型：

```text
Use this tool for all codebase search and discovery.
Do not use shell commands like rg, grep, find, dir, Get-ChildItem, or Select-String when this tool is available.
After search results, use read_file to inspect relevant ranges before editing.
```

Shell 工具的 description 也要配合：

```text
Run tests, builds, package scripts, and runtime commands.
Do not use shell for code search or file editing when dedicated tools are available.
```

### 15.6 Prompt 规则

Developer Prompt 中建议加入：

```text
Search rules:
- Use search for all code discovery.
- Do not call shell for grep/find/listing when search is available.
- Use broad natural language queries when the user describes behavior.
- Use regex-like queries when searching multiple exact keywords.
- Treat fuzzy and semantic results as candidates, not facts.
- Always read relevant files before editing.
- If search returns too many results, refine the query.
```

### 15.7 推荐落地顺序

如果只做一个 `search`，推荐按以下顺序实现内部能力：

1. 文件名检索。
2. 全文检索。
3. 正则检索。
4. 忽略目录和 glob 过滤。
5. 结果结构化返回。
6. 结果排序和去重。
7. 模糊文件名/符号名检索。
8. 符号索引检索。
9. 语义检索。
10. suggestions 和 query 改写。

### 15.8 总结

对 Agent 暴露一个 `search` 是合理的。关键是内部足够智能，外部足够简单：

```text
Agent 只知道：查代码用 search。
Runtime 负责：精确、正则、模糊、符号、语义、多路召回和排序。
```

这种设计比暴露多个相似检索工具更稳定，也更容易通过 Prompt 约束模型不要使用 Shell 检索。

## 16. 批量阅读与代码包工具

只提供单文件 `read_file` 会导致 Agent 在需要理解多个文件时频繁来回调用工具，效率低、上下文碎片化，也不利于一次性建立代码关系。建议在保留 `read_file` 的基础上，提供一个批量阅读工具，例如 `read_many` 或 `read_context`。

推荐原则：

```text
单文件精读用 read_file。
多个文件快速理解用 read_many / read_context。
搜索结果后的候选文件批量预览用 read_context。
```

### 16.1 `read_many`

`read_many` 用于一次读取多个文件或多个文件片段。

```ts
type ReadManyTool = {
  name: "read_many";
  description: "Read multiple files or file ranges in one call. Use this after search returns several relevant files.";
  input: {
    files: Array<{
      path: string;
      offset?: number;
      limit?: number;
      ranges?: Array<{
        startLine: number;
        endLine: number;
      }>;
    }>;
    maxTotalBytes?: number;
    maxTotalLines?: number;
  };
  output: {
    files: Array<{
      path: string;
      startLine?: number;
      endLine?: number;
      totalLines: number;
      truncated: boolean;
      content: string;
      sha256?: string;
    }>;
    truncated: boolean;
    omitted: Array<{
      path: string;
      reason: string;
    }>;
  };
};
```

调用示例：

```ts
read_many({
  files: [
    { path: "src/pages/Home.tsx", offset: 1, limit: 220 },
    { path: "src/components/Sidebar.tsx", offset: 1, limit: 220 },
    { path: "src/routes.tsx", offset: 1, limit: 160 }
  ],
  maxTotalLines: 600
})
```

设计要点：

- 每个文件都应返回路径、行号、总行数、是否截断。
- 必须有全局预算，例如 `maxTotalLines` 或 `maxTotalBytes`。
- 超预算时按相关性读取前几个，剩余放入 `omitted`。
- 不要无限读取超大文件。
- 返回 `sha256`，方便后续编辑校验。

### 16.2 `read_context`

`read_context` 是比 `read_many` 更智能的工具。它不是简单读文件，而是根据搜索结果、符号、行号自动扩展上下文。

```ts
type ReadContextTool = {
  name: "read_context";
  description: "Read a compact context bundle around search results, symbols, or file ranges.";
  input: {
    targets: Array<{
      path: string;
      line?: number;
      symbolName?: string;
      aroundLines?: number;
    }>;
    includeImports?: boolean;
    includeDefinitions?: boolean;
    includeReferences?: boolean;
    maxTotalLines?: number;
  };
  output: {
    bundle: Array<{
      path: string;
      sections: Array<{
        title: string;
        startLine: number;
        endLine: number;
        content: string;
      }>;
      truncated: boolean;
    }>;
    omitted: Array<{
      path: string;
      reason: string;
    }>;
  };
};
```

适用场景：

- 搜索到多个 `Settings` 相关位置后，自动读取每个位置上下 30 行。
- 找到 `SettingsButton` 符号后，自动读取整个组件定义。
- 查 bug 时，同时读取组件、hook、路由、store、测试。
- 做重构前读取定义和引用。

调用示例：

```ts
read_context({
  targets: [
    { path: "src/pages/Home.tsx", line: 86, aroundLines: 40 },
    { path: "src/components/Sidebar.tsx", line: 120, aroundLines: 40 },
    { path: "src/store/settings.ts", symbolName: "openSettings" }
  ],
  includeImports: true,
  includeDefinitions: true,
  maxTotalLines: 500
})
```

### 16.3 与 `search` 的配合

推荐把 `search` 和 `read_context` 设计成连续工作流：

```text
search(query)
→ 返回相关文件、行号、符号和 preview
→ read_context(search results)
→ 得到紧凑上下文包
→ Agent 判断真正相关文件
→ 必要时 read_file 精读某个文件
```

比如用户说：

```text
首页左下角设置按钮点击无效
```

Agent 可以调用：

```ts
search({ query: "首页左下角设置按钮 Settings setting openSettings Sidebar Home", path: "src" })
```

然后对前几个结果：

```ts
read_context({
  targets: search.results.slice(0, 5).map(result => ({
    path: result.path,
    line: result.line,
    aroundLines: 40
  })),
  includeImports: true,
  maxTotalLines: 600
})
```

### 16.4 `read_code_bundle`

如果希望更进一步，可以提供 `read_code_bundle`，让 Runtime 根据主题自动组装代码包。

```ts
type ReadCodeBundleTool = {
  name: "read_code_bundle";
  description: "Build a compact code context bundle for a feature, bug, or symbol.";
  input: {
    query: string;
    path?: string;
    maxFiles?: number;
    maxTotalLines?: number;
    includeTests?: boolean;
    includeConfigs?: boolean;
    includeReferences?: boolean;
  };
  output: {
    files: Array<{
      path: string;
      reason: string;
      sections: Array<{
        startLine: number;
        endLine: number;
        content: string;
      }>;
      truncated: boolean;
    }>;
    summary?: string;
    omitted: Array<{
      path: string;
      reason: string;
    }>;
  };
};
```

内部流程：

```text
query
→ search 多路召回
→ 找定义和引用
→ 找相邻测试
→ 找相关配置
→ 按预算裁剪
→ 返回代码包
```

这个工具适合高级阶段。MVP 可以先做 `read_many` 或 `read_context`。

### 16.5 上下文预算

批量阅读必须有预算，否则很容易把大量文件塞进模型。

建议默认值：

| 参数 | 建议默认值 |
| --- | --- |
| 单文件最大行数 | 200-300 行 |
| 批量最大文件数 | 5-8 个 |
| 批量最大总行数 | 600-1000 行 |
| 搜索结果上下文 | 命中行上下 20-50 行 |
| 超大文件处理 | 返回摘要或要求精读范围 |

超预算时不要静默截断，要明确返回：

```json
{
  "omitted": [
    {
      "path": "src/large-file.ts",
      "reason": "exceeds maxTotalLines; read specific ranges instead"
    }
  ]
}
```

### 16.6 返回格式建议

批量阅读的返回内容要利于模型理解，建议每个片段带标题：

```text
File: src/pages/Home.tsx
Lines: 70-130
Reason: search hit for Settings button

<content>
```

如果是结构化 JSON，也要保留：

- `path`
- `startLine`
- `endLine`
- `totalLines`
- `reason`
- `truncated`
- `content`

### 16.7 Prompt 规则

Developer Prompt 中建议加入：

```text
Reading rules:
- Use read_many or read_context when multiple files are relevant.
- Do not call read_file repeatedly for many files if batch reading is available.
- Prefer read_context after search results to inspect compact surrounding code.
- Use read_file for deep inspection of one specific file or range.
- Respect returned truncation and omitted files; request narrower ranges when needed.
```

### 16.8 推荐落地顺序

建议按以下顺序实现：

1. `read_file` 支持 `offset` / `limit` / `totalLines` / `truncated`。
2. `read_many` 支持多个文件和总预算。
3. `search` 结果可直接作为 `read_context` targets。
4. `read_context` 支持按行号读取周边上下文。
5. `read_context` 支持符号定义范围。
6. `read_code_bundle` 自动组装功能相关代码包。

MVP 阶段最推荐：`search` + `read_many`。这两个已经能显著减少工具调用次数，并让 Agent 更快理解多个文件之间的关系。

## 17. 单一 `read_files` 工具设计

如果希望进一步简化工具集合，可以只暴露一个 `read_files` 工具，让它同时支持单文件读取、多文件读取、指定范围读取和搜索结果批量读取。

推荐原则：

```text
读代码，一律用 read_files。
Agent 不需要区分 read_file、read_many、read_context。
Runtime 负责根据参数和预算返回合适的内容。
```

### 17.1 推荐 Schema

```ts
type ReadFilesTool = {
  name: "read_files";
  description: `
Read one or more workspace files or file ranges.
Use this for all code reading after search results.
Supports single file, multiple files, line ranges, and compact context around lines.
`;

  input: {
    files: Array<{
      path: string;
      offset?: number;
      limit?: number;
      ranges?: Array<{
        startLine: number;
        endLine: number;
      }>;
      aroundLine?: number;
      aroundLines?: number;
      reason?: string;
    }>;
    maxTotalLines?: number;
    maxTotalBytes?: number;
  };

  output: {
    files: Array<{
      path: string;
      totalLines: number;
      sha256?: string;
      sections: Array<{
        startLine: number;
        endLine: number;
        content: string;
        reason?: string;
        truncated: boolean;
      }>;
      truncated: boolean;
    }>;
    truncated: boolean;
    omitted: Array<{
      path: string;
      reason: string;
    }>;
  };
};
```

### 17.2 调用示例

单文件读取：

```ts
read_files({
  files: [
    { path: "src/pages/Home.tsx", offset: 1, limit: 200 }
  ]
})
```

多文件读取：

```ts
read_files({
  files: [
    { path: "src/pages/Home.tsx", offset: 1, limit: 220 },
    { path: "src/components/Sidebar.tsx", offset: 1, limit: 220 },
    { path: "src/routes.tsx", offset: 1, limit: 160 }
  ],
  maxTotalLines: 600
})
```

指定范围读取：

```ts
read_files({
  files: [
    {
      path: "src/pages/Home.tsx",
      ranges: [
        { startLine: 70, endLine: 130 },
        { startLine: 180, endLine: 230 }
      ]
    }
  ]
})
```

搜索结果周边读取：

```ts
read_files({
  files: search.results.slice(0, 5).map(result => ({
    path: result.path,
    aroundLine: result.line,
    aroundLines: 40,
    reason: result.reason
  })),
  maxTotalLines: 600
})
```

### 17.3 返回格式示例

```json
{
  "files": [
    {
      "path": "src/pages/Home.tsx",
      "totalLines": 260,
      "sha256": "abc123",
      "sections": [
        {
          "startLine": 70,
          "endLine": 130,
          "content": "...",
          "reason": "Settings button search hit",
          "truncated": false
        }
      ],
      "truncated": false
    }
  ],
  "truncated": false,
  "omitted": []
}
```

### 17.4 预算与截断规则

`read_files` 必须有预算控制：

- 默认单文件最多 200-300 行。
- 默认总行数最多 600-1000 行。
- 超过预算时返回 `omitted`。
- 每个 section 都要有 `startLine` / `endLine`。
- 每个文件都要有 `totalLines` 和 `truncated`。
- 返回 `sha256`，用于后续编辑校验。

### 17.5 Prompt 规则

Developer Prompt 中建议加入：

```text
Reading rules:
- Use read_files for all code reading.
- Use search first when you do not know which files are relevant.
- Use read_files with multiple files after search returns several relevant results.
- Use ranges or aroundLine to avoid reading entire large files.
- Respect truncation and omitted results; request narrower ranges if needed.
```

Shell 工具描述中也建议写：

```text
Do not use shell commands like cat, type, Get-Content, head, or tail to read files when read_files is available.
```

### 17.6 推荐简化工具组合

如果你想让 Agent 工具集尽量简单，推荐只保留：

```text
search
read_files
apply_patch
shell
```

其中：

- `search` 负责发现文件和候选位置。
- `read_files` 负责读取一个或多个文件内容。
- `apply_patch` 负责修改已有代码。
- `shell` 只负责测试、构建、运行命令，不负责搜索和读写文件。
