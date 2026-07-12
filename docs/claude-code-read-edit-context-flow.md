# Claude Code Read/Edit 上下文完整流程分析

> 调研源码：`F:\MyProjectF\Claude-Code`
> 源码提交：`b78dd22a091b717c8938ab98c736bc04825a8ee8`
> 调研日期：2026-07-12

## 1. 先给结论

Claude Code 对文件存在三个彼此独立的状态层，不能混为“上下文”：

| 层 | 保存什么 | 模型能否直接看到 |
|---|---|---|
| 模型消息上下文 | `Read/Edit` 的 `tool_use` 和对应 `tool_result` | 能 |
| `readFileState` | 文件完整或局部内容、mtime、offset、limit | 不能 |
| JSONL transcript | 完整会话消息和内部工具元数据 | 当前请求不一定发送 |

最关键的行为是：

1. `Read` 后，文本内容进入 `tool_result`，后续请求会继续发送，直到被 microcompact 清理或越过 compact boundary。
2. `Read` 同时更新进程内 `readFileState`，用于防止盲写、检测外部修改和避免连续重复 Read。
3. `Edit` 后，旧 `Read` 消息不会被修改或删除。
4. `Edit` 的模型可见结果只是“文件已更新成功”，不会再次发送编辑后的整文件。
5. 编辑后的完整文件内容会写入 `readFileState`，但模型不能直接读取这个 Map。
6. 下一轮模型依靠“旧 Read 内容 + Edit 的 old/new 字符串 + 成功结果”理解当前文件。
7. `Edit` 会把该文件标记为“由 Edit 更新”，因此下一次 `Read` 不允许返回“文件未变化”stub，必须重新发送当前文件内容。
8. 传统完整 compact 成功后，会从 `readFileState` 选最多 5 个候选文件，重新读取磁盘最新版并作为 attachment 注入。

## 2. 两种上下文必须分开理解

### 2.1 模型消息上下文

模型实际看到的典型消息链为：

```text
assistant: tool_use Read({ file_path })
user:      tool_result("带行号的文件内容")

assistant: tool_use Edit({ file_path, old_string, new_string })
user:      tool_result("The file ... has been updated successfully.")
```

工具执行结束后，`query.ts` 将以下内容组成下一轮消息：

```text
messagesForQuery + assistantMessages + toolResults
```

证据：`F:\MyProjectF\Claude-Code\src\query.ts:1715`。

其中：

- `assistantMessages` 保存模型产生的 `tool_use`，因此 Edit 的 `old_string/new_string` 仍在上下文中。
- `toolResults` 是 user-role 消息，包含与 tool_use_id 配对的 `tool_result`。
- 下一次请求会继续携带这些消息，不会只发送最后一个结果。

### 2.2 `readFileState`

`readFileState` 的元素结构为：

```ts
type FileState = {
  content: string
  timestamp: number
  offset: number | undefined
  limit: number | undefined
  isPartialView?: boolean
}
```

证据：`F:\MyProjectF\Claude-Code\src\utils\fileStateCache.ts:4`。

默认实现是：

- 路径归一化的 LRU Map。
- 最多 100 个条目。
- 内容总量最多 25 MB。
- 同一路径只有一个状态，不保存多段读取区间历史。

证据：`F:\MyProjectF\Claude-Code\src\utils\fileStateCache.ts:17`、`:30`。

这个 Map 不直接拼入 API prompt。它是客户端控制状态，主要负责：

- Edit/Write 前置读取校验。
- 文件 mtime 一致性校验。
- Read 精确范围去重。
- 外部修改检测。
- compact 后文件工作集恢复。

## 3. Read 完整执行流程

### 3.1 模型发出 Read

模型返回 assistant `tool_use`：

```json
{
  "name": "Read",
  "input": {
    "file_path": "...",
    "offset": 1,
    "limit": 2000
  }
}
```

`offset` 和 `limit` 都是可选字段。工具提示告诉模型默认读取最多 2,000 行，但执行代码在 `limit` 未传时不会强制套用 2,000；未传 `limit` 的整文件读取默认受 256 KB 文件总大小限制，所有文本输出受 25K tokens 限制。显式提供 `limit` 时可以读取大文件的局部范围。

证据：

- 输入 schema：`F:\MyProjectF\Claude-Code\src\tools\FileReadTool\FileReadTool.ts:227`
- 2,000 行工具提示：`F:\MyProjectF\Claude-Code\src\tools\FileReadTool\prompt.ts:10`
- 执行限制：`F:\MyProjectF\Claude-Code\src\tools\FileReadTool\limits.ts:1`

### 3.2 路径规范化

Read 首先用 `expandPath()` 转为规范路径。这使 Read、Edit、Write 在 Windows 的 `/`、`\`、相对路径和 `~` 情况下使用同一个状态键。

证据：`F:\MyProjectF\Claude-Code\src\tools\FileReadTool\FileReadTool.ts:518`。

### 3.3 读取前去重判断

Read 查询该路径在 `readFileState` 中的唯一最新状态。只有同时满足以下条件才返回 stub：

1. GrowthBook killswitch 没有关闭去重。
2. 同一路径存在状态。
3. 状态不是 `isPartialView`。
4. 状态的 `offset` 有值，表明最后写入状态的是 Read，而不是 Edit/Write。
5. 新旧 `offset` 完全相同。
6. 新旧 `limit` 完全相同。
7. 当前磁盘 mtime 与状态 timestamp 完全相同。

命中后模型只收到：

```text
File unchanged since last read. The content from the earlier Read tool_result
in this conversation is still current - refer to that instead of re-reading.
```

证据：

- 去重判断：`F:\MyProjectF\Claude-Code\src\tools\FileReadTool\FileReadTool.ts:523`
- stub 映射：`F:\MyProjectF\Claude-Code\src\tools\FileReadTool\FileReadTool.ts:686`

这里的设计含义是：去重不是说“系统知道内容，所以模型不需要内容”，而是明确假设早期完整 Read 结果仍在模型消息上下文里。

### 3.4 真正读取文件

没有命中去重时，文本读取流程为：

```text
readFileInRange
  -> 检查文件总大小/读取范围
  -> 读取文本并规范化内容
  -> 校验输出 token 数
  -> 更新 readFileState
  -> 构造 Read Output
```

成功后状态写入：

```ts
readFileState.set(fullFilePath, {
  content,
  timestamp: Math.floor(mtimeMs),
  offset,
  limit,
})
```

证据：`F:\MyProjectF\Claude-Code\src\tools\FileReadTool\FileReadTool.ts:1019`。

需要注意：`timestamp` 是文件 mtime，不是“模型读取时间”。

### 3.5 Read 内容如何进入模型上下文

文本结果会被转换为 `tool_result`：

- 文件内容加行号。
- 可能附加安全提醒。
- user role。
- 通过 `tool_use_id` 与 assistant 的 Read tool_use 配对。

证据：`F:\MyProjectF\Claude-Code\src\tools\FileReadTool\FileReadTool.ts:692`。

工具执行框架把结果封装为 `createUserMessage({ content: [toolResultBlock] })`：

证据：`F:\MyProjectF\Claude-Code\src\services\tools\toolExecution.ts:1403`、`:1456`。

UI 默认只显示“Read N lines”等摘要，但模型 API 接收完整内容。源码对此有明确注释：

证据：`F:\MyProjectF\Claude-Code\src\tools\FileReadTool\FileReadTool.ts:409`。

### 3.6 Read 后的状态

```text
模型上下文：拥有本次带行号的文件内容
readFileState：拥有原始内容、mtime、offset、limit
磁盘文件：没有变化
```

## 4. Edit 完整执行流程

### 4.1 Edit 为什么要求先 Read

对于已存在且非空的普通文件，Edit 校验要求 `readFileState` 中存在该路径，并且不能是 `isPartialView`。

否则返回：

```text
File has not been read yet. Read it first before writing to it.
```

证据：`F:\MyProjectF\Claude-Code\src\tools\FileEditTool\FileEditTool.ts:275`。

这里检查的是客户端状态，而不是扫描模型消息文本。只要状态还在，连续 Edit 不要求每次重新 Read。

例外：

- 文件不存在且 `old_string == ""` 时，Edit 可以创建文件。
- 已存在的空文件用空 `old_string` 可以通过输入验证，但执行阶段仍会对已存在文件做 read-state 校验；没有状态时会失败。这是验证阶段与执行阶段的一个不完全一致点。
- `.ipynb` 必须使用 NotebookEdit。
- 超过 1 GiB 的文件拒绝 Edit。

证据：`F:\MyProjectF\Claude-Code\src\tools\FileEditTool\FileEditTool.ts:175`、`:223`。

### 4.2 Edit 前的一致性校验

Edit 在验证阶段检查：

1. `old_string` 不能等于 `new_string`。
2. 文件没有被 deny rule 禁止。
3. 文件已经 Read，且不是自动注入的局部视图。
4. 文件 mtime 没有晚于状态 timestamp。
5. 如果 mtime 变了但状态代表完整文件，则比较磁盘内容作为 Windows 时间戳误报的兜底。
6. `old_string` 必须存在。
7. 多次匹配时必须设置 `replace_all`，否则要求提供更精确上下文。

证据：`F:\MyProjectF\Claude-Code\src\tools\FileEditTool\FileEditTool.ts:137`、`:289`、`:315`。

工具真正写入前又执行一次 mtime/内容检查，缩小“验证完成后、写入前文件被其他进程修改”的竞争窗口：

证据：`F:\MyProjectF\Claude-Code\src\tools\FileEditTool\FileEditTool.ts:442`。

### 4.3 写入和状态更新

Edit 用当前磁盘内容计算 patch，然后写入文件。成功后把 `readFileState` 覆盖为编辑后的完整文件：

```ts
readFileState.set(absoluteFilePath, {
  content: updatedFile,
  timestamp: getFileModificationTime(absoluteFilePath),
  offset: undefined,
  limit: undefined,
})
```

证据：`F:\MyProjectF\Claude-Code\src\tools\FileEditTool\FileEditTool.ts:481`、`:519`。

这一步有三个效果：

1. 后续 Edit 可以继续执行，无需重新 Read。
2. 后续外部修改可以与编辑后的内容比较。
3. 后续 Read 不会错误地引用编辑前的 Read 内容。

### 4.4 Edit 后模型究竟看见什么

Edit 内部返回的数据包含：

- `oldString`
- `newString`
- `originalFile`
- `structuredPatch`
- `userModified`

这些数据用于 UI、diff 和 transcript 元数据。模型 API 中的 `tool_result` 只包含短消息：

```text
The file <path> has been updated successfully.
```

证据：`F:\MyProjectF\Claude-Code\src\tools\FileEditTool\FileEditTool.ts:560`、`:575`。

所以 Edit 后并不存在“把旧 Read 全文替换成新全文”的操作。下一轮模型看到的是：

```text
旧 Read 全文
+ Edit tool_use 中的 old_string/new_string
+ Edit 成功结果
```

模型通过 patch 语义理解新状态；更新后的完整内容只存在磁盘和 `readFileState` 中。

## 5. Read -> Edit -> 下一轮的精确状态变化

### 5.1 初次 Read

```text
消息上下文：加入 Read tool_use + 文件全文 tool_result
readFileState：{ content: 读取内容, mtime, offset: 1, limit }
```

### 5.2 Edit 成功

```text
消息上下文：保留旧 Read，再加入 Edit tool_use + 成功短消息
readFileState：覆盖为 { content: 编辑后全文, 新 mtime, offset: undefined, limit: undefined }
```

### 5.3 紧接着再次 Edit

如果磁盘未被其他进程修改：

- 不要求重新 Read。
- 使用更新后的 `readFileState` 通过校验。
- 再次覆盖完整内容和 mtime。

### 5.4 紧接着再次 Read

这次不会命中 Read stub。原因是 Edit 写入的状态明确设置：

```text
offset = undefined
limit = undefined
```

而 Read 去重只接受 `offset !== undefined` 的状态。源码注释直接说明这是为了避免让模型引用编辑前的 Read 内容。

因此 Read 会重新访问磁盘，并把请求范围内的编辑后最新版内容作为新的 `tool_result` 加入上下文；读取仍可能受大小、token 和权限限制而失败。

此时上下文会同时存在：

- 编辑前 Read 内容。
- Edit patch。
- 编辑后 Read 内容。

这不是状态错误，而是历史消息不可变带来的正常重复。后续 compact/microcompact 才负责回收旧版本。

## 6. 常见调用序列结果

| 调用序列 | 是否重新返回全文 | 原因 |
|---|---|---|
| `Read A -> Read A`，范围相同、mtime 不变 | 否，返回 stub | 最新状态来自 Read 且范围完全相同 |
| 同一文件 `Read A范围 -> Read B范围 -> Read A范围` | 是 | 同一路径只保存最新一个范围，B 覆盖 A |
| `Read -> Edit -> Edit` | 否，不要求重新 Read | Edit 后状态保存编辑后完整内容 |
| `Read -> Edit -> Read` | 是 | Edit 状态禁止 Read dedup，避免引用旧内容 |
| `Read -> 外部编辑 -> Edit` | Edit 被拒绝 | mtime/内容表明文件已变化 |
| 普通运行时 `Read -> 外部编辑 -> 下一模型轮次` | 通常不自动注入 | 缺省 Read 状态的 offset 被写成 1，变化扫描把它视为范围读取并跳过 |
| `Edit -> 外部编辑 -> 下一模型轮次` | 注入变化片段 | Edit 状态的 offset/limit 都是 undefined，符合变化扫描条件 |
| 只做局部 Read -> Edit | 可以，前提是 mtime 未变化且 old_string 可唯一定位 | 普通范围读取不是 `isPartialView` |
| 自动注入的裁剪 CLAUDE.md -> Edit | 不可以 | `isPartialView` 要求显式 Read |

## 7. 外部文件修改如何进入上下文

每轮工具执行结束后，Claude Code 会尝试检查 `readFileState` 中的文件：

1. 仅检查 offset/limit 都为 undefined 的状态。
2. 比较当前 mtime 与缓存 timestamp。
3. mtime 更新后重新 Read。
4. 计算旧内容与新内容的差异片段。
5. 以 `edited_text_file` attachment 注入下一轮。
6. 如果只是 touch、内容没变，则不注入。
7. 文件确实删除时从状态 Map 移除；临时 EACCES/stat 失败不会移除。

证据：`F:\MyProjectF\Claude-Code\src\utils\attachments.ts:2063`。

这里存在一个实现细节：Read 的 `call()` 把缺省 offset 解构为 1，并把 1 写入 `readFileState`；`getChangedFiles()` 又跳过任何 offset 有值的状态。因此当前进程中的普通无参数 Read 也不会进入变化扫描。以下状态会进入扫描：

- Edit/Write 写入的完整状态，offset/limit 都是 undefined。
- resume 从完整 Read 消息重建的状态，offset/limit 被设为 undefined。
- 其他明确以 undefined 写入的完整文件状态。

所以不能笼统地说“任何 Read 过的文件，外部修改都会自动通知模型”。

Claude Code 自己完成 Edit 后会立即把新 mtime 写入状态，所以正常情况下不会把自己的 Edit 再识别为“外部修改”。如果 formatter 或用户随后再次修改文件，下一轮才会注入新差异。

## 8. Microcompact 如何处理 Read/Edit

Read 和 Edit 都在 `COMPACTABLE_TOOLS` 集合中：

证据：`F:\MyProjectF\Claude-Code\src\services\compact\microCompact.ts:40`。

时间型 microcompact 在启用并触发时：

- 保留最近 N 个可清理工具结果，默认 N=5。
- 把更旧的 `tool_result.content` 替换为 `[Old tool result content cleared]`。
- 不删除对应 assistant `tool_use`。
- 不修改 `readFileState`。

证据：`F:\MyProjectF\Claude-Code\src\services\compact\microCompact.ts:446`。

该功能默认关闭，默认条件为主线程空闲 60 分钟：

证据：`F:\MyProjectF\Claude-Code\src\services\compact\timeBasedMCConfig.ts:30`。

Cached microcompact 使用服务端 cache editing，不直接修改本地消息；恢复源码缺少其核心实现，不能完整确认 Read stub 与已删除服务端结果之间的同步策略。

## 9. 传统完整 compact 如何处理文件

成功生成 summary 后，传统 `compactConversation()` 执行：

```text
复制 readFileState
-> 清空 readFileState
-> 过滤候选文件
-> 排序并取最多 5 个
-> 使用 FileReadTool 重新读取磁盘最新版
-> 作为 post-compact attachment 注入
```

证据：

- 保存并清空状态：`F:\MyProjectF\Claude-Code\src\services\compact\compact.ts:517`
- 调用恢复：`F:\MyProjectF\Claude-Code\src\services\compact\compact.ts:531`
- 选择和重读：`F:\MyProjectF\Claude-Code\src\services\compact\compact.ts:1415`

限制为：

- 候选最多 5 个。
- 每文件最多 5K tokens。
- 文件 attachment 总预算 50K tokens。
- 排除 plan 文件和标准 CLAUDE.md。
- 文件不存在、权限拒绝或读取失败时跳过。
- 文件过大时可能只保留 `compact_file_reference`。

### 9.1 “最近 5 个”的源码真实含义

选择代码按 `FileState.timestamp` 降序，而运行时 Read/Edit 写入的 timestamp 是文件 mtime，并不是最后读取/编辑操作发生的墙钟时间。

因此严格来说，它选的是：

> `readFileState` 中 timestamp 最大的最多 5 个合格条目。

不能严格称为“最近读取的 5 个文件”。此外，resume 重建的 Read 状态使用消息时间，而 Edit 重建使用磁盘 mtime，因此恢复后的 timestamp 语义还可能混合。

### 9.2 实验性 Session Memory Compact

Session Memory Compaction 不调用上述文件恢复函数。它只显式添加 plan attachment，并保留一段近期消息 tail：

证据：`F:\MyProjectF\Claude-Code\src\services\compact\sessionMemoryCompact.ts:475`。

因此“compact 后恢复最多 5 个文件”只适用于传统完整 compact 和 partial compact，不适用于这条默认关闭的实验路径。

## 10. Resume 如何重建文件状态

`readFileState` 是进程内 Map。恢复会话时，Claude Code 从 transcript 重建它：

证据：`F:\MyProjectF\Claude-Code\src\utils\queryHelpers.ts:346`。

重建规则：

### 10.1 Read

- 只恢复工具输入中没有显式 offset/limit 的完整 Read。
- 从 tool_result 中去除 system-reminder 和行号。
- Read dedup stub 不覆盖早期真实内容。
- 使用消息 timestamp，offset/limit 被设为 undefined。
- 局部 Read 不恢复。

### 10.2 Edit

- 找到成功的 Edit tool_result。
- 因为 Edit 结果没有完整新文件，所以直接读取当前磁盘内容。
- 使用当前文件 mtime。
- 文件已删除或不可访问则跳过。

证据：`F:\MyProjectF\Claude-Code\src\utils\queryHelpers.ts:415`。

这意味着 resume 后 Edit 校验依据的是“当前磁盘状态”，不是机械重放所有 old_string/new_string 生成文件。

## 11. 设计边界与潜在问题

### 11.1 `readFileState` 不是模型记忆

它不能帮助模型回答文件细节，只能帮助客户端校验、去重和恢复。若旧 Read tool_result 已从模型视图清理，仅保留 Map 不能等价替代模型上下文。

### 11.2 同一路径只保存一个范围

范围 A、范围 B、再范围 A 会重新读取，因为 B 已覆盖 A。它不是区间缓存。

### 11.3 Edit 后重读全文是有意行为

内部状态已经知道编辑后全文，但模型此前只看到旧全文和 patch。返回新全文可以建立新的模型可见快照，不能简单视为无意义重复。

### 11.4 时间型 microcompact 与 Read stub 存在一致性要求

时间型 microcompact 可以清除早期 Read tool_result，但不清理 `readFileState`。如果随后仍允许返回“参考早期 Read”的 stub，就可能引用模型不可见内容。该路径默认关闭；恢复源码中 cached microcompact 的完整补偿逻辑不可审计。

### 11.5 compact 的“最近”排序不是访问时间

使用 mtime 排序会让“刚读过但很久未修改”的文件排名较低。这可能导致 compact 后重新 Read，是值得 CodeZ 避免复制的实现细节。

## 12. 最终状态机

```text
                      Read 成功
  未知文件状态 --------------------------> ReadState(range, content, mtime)
       |                                         |
       | Edit 拒绝                               | 相同范围 Read + mtime 相同
       |                                         v
       |                                  返回 unchanged stub
       |                                         |
       |                                         | Edit 成功
       |                                         v
       +---------------------------------- EditState(full content, new mtime)
                                                 |
                                      +----------+----------+
                                      |                     |
                                 再次 Edit              再次 Read
                                      |                     |
                               可直接继续编辑        必须返回新版内容
```

对应模型上下文则始终是追加式历史：

```text
Read旧全文 -> Edit patch -> 成功结果 -> 可选的Read新全文
```

旧 Read 不会因 Edit 被原地更新。只有 microcompact、完整 compact 或 context boundary 投影会让旧内容不再进入模型请求。
