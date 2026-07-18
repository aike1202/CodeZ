# Glob、Grep 与 list_files

## 共同安全模型

Glob/Grep 不把模型字符串拼进 shell。它们调用 packaged `SearchService`，由已验证的 bundled ripgrep executable 执行。规划 effect 是 workspace-scoped `ReadFile`，执行前要求同一个 workspace authority。

共同边界：

```yaml
max_pattern_bytes: 16384
max_path_bytes: 4096
max_filter_bytes: 4096
max_results: 5000
timeout: 35s
```

## Glob

```text
validate pattern/path/head_limit
-> resolve optional path inside workspace
-> invoke SearchService glob mode
-> normalize workspace-relative paths
-> cap at head_limit
-> return sorted bounded path list and truncation state
```

适合文件发现，不读取文件内容。

## Grep

支持：

```text
files_with_matches | content | count
glob filter OR ripgrep type filter
-A / -B / -C context
-n / -i / -o
multiline
head_limit + offset pagination
```

`output_mode` 决定 SearchService 的解析路径。没有结果时返回 `No matches found.`；结果超过 limit 会在 model content 中提示缩小 pattern/path 或使用 offset。

## list_files

`list_files` 不调用 shell/ripgrep，而是通过 trusted FileSystem 读取一个或多个目录的直接 children：

```text
normalize dirPaths or legacy dirPath
-> unique, max 32 directories
-> resolve each inside workspace
-> read directory without following links
-> max 2000 entries per directory
-> tag [DIR] / [FILE]
-> cap aggregate model content at 80000 chars
```

它不递归。要递归匹配应使用 Glob；要按内容匹配应使用 Grep。

## 为什么 Explore 不应默认派发

这三项工具已经可以并行批量完成大多数定向查找。Explore registry 也明确规定：一个直接 Glob/Grep/Read 能快速回答时不要派 Explore。当前问题不是工具能力不足，而是这条目录策略没有进入主 Prompt。
