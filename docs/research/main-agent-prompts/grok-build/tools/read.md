# Grok Build `read_file`

来源：`crates/codegen/xai-grok-tools/src/implementations/grok_build/read_file/mod.rs`。

## 输入 schema

| 字段 | 类型 | 语义 |
|---|---|---|
| `target_file` | string | 工作区相对或绝对路径 |
| `offset` | signed integer，可选 | 1-based 起始行；支持负数从尾部定位；0 归一为 1 |
| `limit` | integer，可选 | 读取行数 |
| `pages` | string，可选 | PDF 页范围；超过 10 页的 PDF 要求指定，单次最多 20 页 |
| `format` | string，可选 | PDF `image`（默认）或 `text` |

支持文本、图片、PDF、PPTX 和 Notebook。PPTX 上限 50 MiB，提取超时 60 秒；图片或内嵌 base64 图片会进入多模态 content part。

## 预算

- 最大读取行数由 `TruncationCfg.max_lines_read()` 给出，默认常量为 1,000。
- 模型传入 `limit` 会被 `min(limit, max_lines)` 截断。
- 格式化结果估算超过 25,000 tokens 时返回 `FileTooLarge`，并建议减小范围或使用 Grep。
- Skill 文件是特殊路径：可以绕过常规 offset/limit 和 token 限制，以保证 skill 正文完整载入。这会显著扩大上下文。

## 负 offset 算法

```text
offset > 0 -> 直接作为 1-based 起点
offset = 0 -> 1
offset < 0 -> split('\n') 字段数 + offset + 1，最小为 1
```

对没有尾随换行的非空文件还会加入一个 phantom field，以兼容参考 harness。这个行为不是简单的按显示行数钳制。

## 行号格式的源码事实

工具描述声称结果格式是 `LINE_NUMBER→LINE_CONTENT`。当前 `extract_file_content_lines()` 实际只给第一条可见行和每个 10 的倍数行加前缀，其余行直接输出：

```text
1→first
second
...
10→tenth
```

`content` 与 `content_concise` 当前使用相同算法。这是 prompt 文案与实现的细微差异，CodeZ 不应照搬描述而忽略测试固定的真实格式。

## 执行流程

```text
resolve_model_path
-> contract/gitignore/path/type 检查
-> media 分支或读取 bytes
-> UTF-8 解码/文档提取
-> resolve offset + clamp limit
-> 逐行格式化并提取 inline images
-> token 估算
-> 可选约 4 KiB 的流式 delta
-> 返回 FileContent + metadata/truncation 信息
```

与 Claude 不同，当前 Grok Read 没有文档所示的 per-session `readFileState`、mtime 去重 stub 或 Edit 前置读取证明。
