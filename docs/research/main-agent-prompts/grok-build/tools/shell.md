# Grok Build `run_terminal_cmd`

来源：`crates/codegen/xai-grok-tools/src/implementations/grok_build/bash/mod.rs`。

## 输入 schema

| 字段 | 类型 | 说明 |
|---|---|---|
| `command` | string | shell 命令 |
| `timeout` | integer/string，可选 | 毫秒，lenient 反序列化 |
| `description` | string | 运行原因和目标 |
| `is_background` | bool | 后台任务，feature 关闭时从 schema 删除 |

## Timeout 语义

- 前台默认 120 秒，默认最大 5 分钟；宿主可配置，绝对上限 10 小时。
- 前台显式正数会被前台 ceiling 钳制。
- 后台显式正数只受 10 小时绝对上限，不受前台 ceiling。
- 后台 `timeout: 0` 或省略表示 wrapper 无期限，由 kill task 管理生命周期。
- `auto_background_on_timeout` 打开时，前台超过 timeout/短阻塞预算可转为后台，而不是杀死。

## 后台操作符检查

工具根据 shell 区分 `&`：

- current Bash 检测未被引号、heredoc、`&&`、重定向等吸收的裸 `&`。
- legacy Bash 和 PowerShell 只关注末尾 `&`；PowerShell 开头 `&` 是 call operator。
- cmd.exe 的 `&` 是顺序分隔符，不按后台操作符拒绝。

检测器维护引号、escape、heredoc 和 redirect 状态，并用大量边界测试固定行为。推荐模型使用结构化 `is_background=true`，不要把 `&` 混入命令。

## 执行算法

```text
读取 Terminal/SessionFolder/Env/Params
-> 校验 background operator、自匹配 pkill、background feature
-> 追加可选 cmd_prefix
-> 生成 session/terminal/<tool_call_id>.log
-> 后台：Terminal.run_background，返回 task_id/pid/output_file
-> 前台：Terminal.run，timeout 时 kill 或 auto-background
-> 发送 background/complete/failed/timeout/output-chunk 通知
-> 格式化 exit code、signal、截断和 output file
```

Unix timeout 对 process group 先 SIGTERM，约 1 秒后 SIGKILL；Windows 终止 Job Object。命令输出超预算时保留前/后片段并给出完整 output file，流式 delta 在 UTF-8 边界截断。

## 权限边界

该工具源码主要负责 schema、后台、timeout、output 和少量命令语义保护。更高层 capability/permission/sandbox 由 tool runtime 和 host 资源控制，不能把 Bash 模块本身误认为完整安全策略。
