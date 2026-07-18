# Read 工具

## Provider 描述

```text
Reads bounded text files after path authorization.
```

输入 schema 已完整列在 catalog 文件。一个调用可读取多个文件，每项使用 1-based `offset`，`limit` 最大 5000 行。

## 核心算法

```text
for each requested file
  -> resolve_tool_path(raw, workspace_root)
  -> reject invalid/outside authority according to permission effects
  -> verify authorized ReadFile effect still matches resolved path
  -> inspect metadata; require regular bounded text file
  -> reject file larger than 10 MiB
  -> read bounded bytes through trusted FileSystem port
  -> require valid UTF-8
  -> split into lines
  -> apply 1-based offset and <=5000-line limit
  -> prefix each returned line with its source line number
  -> record SHA-256/current delivery in ReadFingerprintStore
```

Read 的 fingerprint 是后续 Edit/Write/NotebookEdit 防止 stale write 的基础。它不是只在 Prompt 中要求“先 Read”，运行时也会检查当前 Agent context 是否拿到过相应版本。

## 路径边界

`resolve_tool_path` 将相对路径绑定到 canonical workspace root，识别 workspace 内外。Effect planning 先产生 `ReadFile { path, scope }`，真正执行前再次比对 authorized effect，避免授权后参数或解析结果漂移。

## 输出

成功结果同时包含结构化 data 和 model-visible text。多文件输出保持文件边界；截断会明确说明后续 offset。Processor 再应用 per-tool 100k chars 和 batch budget，超限时可能返回 `tool-result://` handle。

## 重要限制

- 不读取二进制或无效 UTF-8 作为文本。
- 不跟随越界 authority。
- 单文件读取不是无界 `read_to_string`。
- 行号前缀不是文件原文；Edit 的 `old_string` 必须去掉前缀。
