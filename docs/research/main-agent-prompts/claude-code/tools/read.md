# Claude Code `Read`

来源：`src/tools/FileReadTool/prompt.ts`、`FileReadTool.ts`、`limits.ts`、`src/utils/fileStateCache.ts`。

## 输入契约

| 字段 | 类型 | 语义 |
|---|---|---|
| `file_path` | string | 绝对路径；运行时会展开和规范化 |
| `offset` | number，可选 | 起始行，提示层默认从 1 开始 |
| `limit` | number，可选 | 读取行数；提示建议默认最多 2,000 行 |
| `pages` | string，可选 | PDF 页范围 |

工具同时支持文本、常见图片、Jupyter Notebook 和 PDF。图片作为多模态内容返回；Notebook 以 cell 结构展示；PDF 有页数/页范围约束。

## 双重输出限制

| 限制 | 默认值 | 检查对象 | 超限行为 |
|---|---:|---|---|
| `maxSizeBytes` | 256 KiB | 整个文件大小，不是 slice | 读取前抛错 |
| `maxTokens` | 25,000 | 实际文本输出 | 读取后抛错 |

`maxTokens` 优先级为环境变量 `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`、GrowthBook、硬编码默认。显式 `limit` 并不意味着一定绕过总文件大小门槛，这一点容易误判。

## 文本执行流程

```text
expandPath(file_path)
-> 权限/类型/存在性检查
-> 查询 readFileState 去重条件
-> readFileInRange
-> 检查文件大小和输出 token
-> 生成带行号内容
-> 更新 readFileState
-> 返回 tool_result
```

模型看到带行号正文；UI 可以只展示“Read N lines”摘要。`readFileState` 不直接进入模型上下文，它是客户端控制状态。

## `readFileState`

每个规范化路径只保留一个最新状态：

```ts
{
  content: string,
  timestamp: number,
  offset: number | undefined,
  limit: number | undefined,
  isPartialView?: boolean
}
```

实现是 LRU，最多 100 项、25 MiB 内容。它用于 Edit 前置读取证明、mtime 一致性、Read 去重、外部修改检测和 compact 后工作集恢复，不是模型记忆。

## 精确范围去重

只有同时满足以下条件才返回 `FILE_UNCHANGED_STUB`：

1. 去重 feature 未关闭。
2. 同一路径已有状态，且不是 `isPartialView`。
3. 状态的 `offset` 有值，说明最后状态来自 Read。
4. 新旧 `offset` 和 `limit` 完全相同。
5. 当前 mtime 与缓存 timestamp 完全相同。

模型得到的 stub 让它引用会话中更早的 Read 结果。缓存不是区间缓存：先读范围 A、再读 B、再读 A 时，B 已覆盖路径唯一状态，A 会重新读取。

## 与 Edit 的状态机

Edit/Write 成功后把 `offset`、`limit` 设为 `undefined`。因此 `Read -> Edit -> Read` 必须重新返回编辑后内容，不会错误提示模型引用编辑前的 Read；`Read -> Edit -> Edit` 则可连续编辑，无需再次 Read。

## Compact/Resume

传统完整 compact 会清空状态，从旧状态中按 timestamp 选最多 5 个候选，再读取磁盘最新版作为 attachment。这里 timestamp 通常是文件 mtime，不是真正访问时间。Resume 会从完整 Read 和成功 Edit 的 transcript 重建状态；局部 Read 通常不恢复。

详细上下文状态变化另见仓库根文档 `docs/claude-code-read-edit-context-flow.md`。
