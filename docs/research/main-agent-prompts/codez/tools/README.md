# CodeZ 工具系统

## 当前目录规模

```text
builtin catalog: 27
main first-round provider tools: 24
deferred: 4
agent-specific allowlists: Explore 8, Reviewer 10
MCP provider tools: 0 on current ChatToolRuntime path
```

`AskUserQuestion` 不在 immutable builtin catalog 内，而是在主 run 生成 Provider definitions 时单独追加，所以总候选面可看作 28。

## 文件

- `catalog-and-schemas.md`：所有当前工具的描述、exposure 和输入 JSON Schema。
- `read.md`：Read 的路径、边界、行号和 fingerprint。
- `edit-write-notebook.md`：Edit/Write/NotebookEdit 的事务算法。
- `grep-glob-list.md`：不经过 shell 的 bundled ripgrep 与目录读取。
- `shell.md`：Bash/PowerShell、命令任务、权限解析和 UTF-8 修正。
- `agent-tools.md`：spawn/followup/send/list/wait/interrupt。
- `task-skill-deferred.md`：Task、Skill、ToolSearch 和 deferred exposure。
- `permission-pipeline.md`：验证、effects、授权、调度、执行和 journal。
- `large-results-web.md`：大结果 handle、Web SSRF 防护和通知限流。

## ToolDescriptor 契约

每个 handler 提供：

```text
name / aliases / version / source / source_id
summary / description / search_hint
input_schema / optional output_schema
approval metadata
availability: roles, platforms, exposure
behavior: concurrency, interrupt, max_result_chars, timeout_ms
is_enabled / is_read_only / is_destructive
plan_effects / resource_keys
execute
```

Rust trait object 允许 catalog 容纳不同 handler。`ToolExposurePlanner` 先按角色/deny/internal/deferred 过滤，再按 Always 优先、名称排序；Core 工具受 schema budget 影响，Always 工具必须加载。
