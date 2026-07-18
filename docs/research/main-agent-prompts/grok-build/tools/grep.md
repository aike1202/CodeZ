# Grok Build `grep`

来源：`crates/codegen/xai-grok-tools/src/implementations/grok_build/grep/mod.rs` 和 `ripgrep.rs`。

## 输入 schema

| 字段 | 说明 |
|---|---|
| `pattern` | ripgrep 正则 |
| `path` | 文件/目录，默认 workspace |
| `glob` | `--glob` 过滤 |
| `type` | `--type` |
| `-B` / `-A` / `-C` | 上下文行 |
| `-i` | 忽略大小写 |
| `multiline` | `-U --multiline-dotall` |
| `head_limit` | 前 N 行/项 |
| `output_mode` | wire 可接受 `content/files_with_matches/count`，但当前 JSON schema 隐藏该字段 |

## 限制

| 模式 | 省略 `head_limit` | 显式上限 |
|---|---:|---:|
| content | 200 行 | 2,000 行 |
| files/count | 500 项 | 10,000 项 |

另外有 5,000,000 bytes 的 stdout 硬上限、默认 1,000 chars/line、配置化累计输出上限。每个被搜索文件还传 `--max-filesize 5M`。

## 核心早停算法

```text
构造 rg child + stdout/stderr pipe
-> 读取 effective_limit + 1 行
-> 同时执行 5 MB byte cap
-> 达到预算时做最多 100 ms 的 exact-fit probe
-> 确认还有数据则标记 truncated
-> 立即 kill rg，避免继续遍历大树
-> 限量读取 stderr
-> 格式化匹配、文件列表、计数和 truncation footer
```

多读一行解决“刚好 N 行”和“至少 N+1 行”的歧义，100 ms probe 防止刚好填满 buffer 时无限等待。提前 kill 放在 stderr drain 之前，否则仍在遍历的 rg 可能保持 pipe 打开，让已有匹配在外层 timeout 时全部丢失。

## 超时

非 WSL 默认 20 秒，WSL 默认 60 秒。超时时会 kill child；流式路径若已有内容，会保留部分结果并追加 partial notice，而不是只返回空 timeout 卡片。

## 权限与 deny globs

managed `DenyReadGlobs` 被转换为 `--glob !pattern`，并放在用户 glob 之后，使 deny 成为最后匹配规则。显式目标路径仍由更上层 permission manager 阻止，因为 ripgrep 对显式路径的行为不能只靠 exclude 保证。

## 流式一致性

打开 workspace viewer streaming 时，工具只流式发送格式化后的 card body，而不是原始 stdout。terminal card 从同一 raw buffer 重新构建，目标是 streamed delta 成为最终正文的忠实前缀。
