# Grok Build `search_replace`

来源：`crates/codegen/xai-grok-tools/src/implementations/grok_build/search_replace/mod.rs` 与 `helpers.rs`。

## 输入 schema

```json
{
  "file_path": "src/main.rs",
  "old_string": "exact text",
  "new_string": "replacement",
  "replace_all": false
}
```

工具描述要求先用 Read 阅读文件，并提醒 `LINE_NUMBER→` 不是文件内容。`old_string` 默认必须唯一；多匹配时提供更多上下文或设置 `replace_all=true`。

## 真实强制边界

“先 Read”主要是 prompt 约束。`requires_expr()` 只确保 toolset 中存在 Read 工具，并没有检查当前 session 是否真的读过目标文件。执行时会重新读取磁盘，因此它能发现 old string 不匹配，但没有 Claude `readFileState` 那种 mtime 基线和写前第二次竞态检查。

## 核心替换算法

```text
解析/规范化路径
-> component 长度 <= 255
-> 拒绝目录、gitignored 目标和 old==new
-> old 为空：创建或按配置覆盖
-> 读取当前文件
-> 若含 CRLF，匹配视图先统一为 LF
-> match_indices 精确字节匹配
-> 无匹配时可选 Unicode confusable normalized fallback
-> 唯一性/replace_all 校验
-> 按位置重建新文本
-> 恢复 CRLF 风格
-> 写盘
-> 发送 FileWritten notification
-> 返回短成功文案和结构化 edit context
```

## Unicode fallback

配置 `unicode_normalized_fallback` 默认关闭。打开后，精确匹配失败会把 smart quotes、em dash、NBSP、ellipsis 等 confusable 归一化，并保存归一位置到原始字节区间的映射。只接受无重叠、完整字符展开且不歧义的匹配；部分命中一个 em dash 或 ellipsis 的内部字符会拒绝，避免错位写入。

## 错误提示算法

无匹配时会：

- 提示重新 Read，说明用户可能已修改文件。
- 从 `old_string` 第一行选最长 token，在文件中找最近行并给出最多约 200 字符提示。
- 检测匹配区域是否只因 Unicode typography 不同而失败。

## 文件创建语义

空 `old_string` 进入创建/覆盖分支。`empty_old_string_does_not_override` 默认 false，因此默认可覆盖已有非空文件；打开保护后只允许新文件或空文件。产品若追求保守编辑，应默认打开此保护或拆出独立 Write 工具。

## 并发风险

读取和写入之间没有可见的 mtime/CAS 二次校验。并行 Agent 同时编辑同一文件时，后写者可能覆盖前写者的改动。worktree 隔离或编辑层 compare-and-swap 是更可靠的解决方案。
