# Claude Code `Edit` 与 `Write`

来源：`src/tools/FileEditTool/prompt.ts`、`types.ts`、`FileEditTool.ts`，以及 `src/utils/fileStateCache.ts`。

## `Edit` 输入 schema

| 字段 | 类型 | 规则 |
|---|---|---|
| `file_path` | string | 目标文件绝对路径 |
| `old_string` | string | 要替换的精确文本 |
| `new_string` | string | 必须不同于 old string |
| `replace_all` | bool，可选 | 多匹配时全部替换 |

## 输入与状态校验

对已有普通文件，Edit 真正强制“先 Read”：它检查 `readFileState`，不是在聊天文本中搜索 Read 消息。主要条件：

1. `old_string != new_string`。
2. 文件未命中 deny rule，且不是 `.ipynb`。
3. 已有 Read 状态，且不是自动注入的局部视图。
4. 磁盘 mtime/内容没有在 Read 后改变。
5. `old_string` 至少匹配一次。
6. 多次匹配时必须 `replace_all=true` 或提供更多上下文。

新文件可以用空 `old_string` 创建。超大文件和 Notebook 被转向专用流程。

## 核心算法

```text
读取 readFileState 作为基线
-> 检查磁盘 mtime；必要时比较内容规避 Windows mtime 误报
-> 计算精确匹配位置
-> 唯一性/replace_all 校验
-> 生成更新后全文和 structured patch
-> 写入前再次检查 mtime/内容，缩小 TOCTOU 窗口
-> 写盘
-> readFileState = 编辑后完整内容 + 新 mtime + offset/limit undefined
```

第二次竞态检查是关键。它避免“校验通过后，用户或 formatter 又修改文件，Edit 仍覆盖新内容”。

## 模型可见结果

成功 tool result 只是短消息：

```text
The file <path> has been updated successfully.
```

完整 `originalFile`、`structuredPatch`、old/new string 和 UI diff 保留在内部结果/transcript metadata。下一轮模型依靠“旧 Read 全文 + Edit tool call 中的 patch + 成功消息”理解新状态，系统不会回写历史 Read 消息。

## `Write`

`FileWriteTool` 用于完整创建或覆盖文件。对已有文件同样依赖 Read 状态和外部修改检查；成功后也把完整新内容写入 `readFileState`，并用 `offset/limit = undefined` 迫使下次 Read 返回最新版。Claude 的 Bash prompt 明确要求文件写入优先使用 Write，而不是 shell 重定向。

## 与 Grok 的关键差异

Claude 的“先 Read”是运行时状态约束，并有写入前二次竞态检查。Grok `search_replace` 的提示也要求先 Read，但当前源码主要在执行时重新读文件并精确匹配，没有同等的 per-session Read proof 或 mtime 二次比较。
