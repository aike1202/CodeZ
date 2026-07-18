# Codex 文件读取与搜索

## 当前可见契约

本机 Codex Desktop 运行时没有向模型暴露单独的 `Read`、`Grep` 或 `Glob` 函数。主 Agent 通过 `exec_command` 执行只读命令：

```text
rg --files
rg -n -C ... pattern paths...
Get-Content -Encoding UTF8 path
git status --short
git show ...
```

基础 prompt 明确要求搜索优先使用 `rg`，`rg` 不可用时再选替代品。PowerShell 读取中文内容时，项目 `AGENTS.md` 可以进一步要求显式 UTF-8。

## `exec_command` 与读取

`exec_command` 的关键字段：

| 字段 | 语义 |
|---|---|
| `cmd` | 交给所选 shell 的完整命令字符串 |
| `workdir` | 工作目录 |
| `yield_time_ms` | 初次等待时长，超时则返回 session ID |
| `max_output_tokens` | 本次返回输出预算 |
| `shell` | 可选 shell binary |
| `tty` | 是否分配 PTY |

文件读取的行号、分页、最大字节、二进制/图片支持和缓存均由所用命令及运行时输出截断共同决定，不存在可观察的统一 Read 状态机。

## 与 Claude/Grok 的差异

- 没有证据表明 Codex 维护 Claude 式 `readFileState`、mtime 去重 stub 或“Edit 前必须 Read”的客户端 Map。
- 没有单独 Grep schema 的 `output_mode/head_limit/offset`；需要在 `rg` 参数和 shell 输出预算中显式表达。
- 权限判断看到的是 shell command，而不是专用 Read/Grep 的结构化 path/pattern 字段。

## 可复用建议

Codex 的优势是 shell 通用性和工具组合灵活；缺点是权限分类、路径提取和输出预算更依赖 shell parser。CodeZ 应保留专用 Read/Grep/Glob 作为常用安全通道，Shell 作为补充，而不是为了模仿 Codex 把全部读取降级为字符串命令。
