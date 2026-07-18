# Bash 与 PowerShell

## 两种调用模式

```text
start:     { command, timeout?, run_in_background? }
control:   { task_id, action: wait | interrupt, timeout? }
```

默认 command wait 为 30 秒，最大 120 秒。Wait timeout 不会自动杀死进程，而是返回 retained `task_id`；registry 默认保留任务 15 分钟，最多 100 个。

## 执行路径

```text
schema validate
-> normalize_input
-> parse shell syntax and derive effects
-> authorize command/effects
-> issue authorization receipt bound to args/effects/workspace/session/role
-> schedule Exclusive wave
-> revalidate receipt and binding
-> choose session working directory
-> launch discovered absolute shell executable with curated environment
-> stream/capture bounded output
-> retain on timeout/background, or return terminal status
```

Shell effect parser尝试识别 read/write/process/network/control effects。无法完整分类时不是“当作安全”，而是产生 unparsed/unknown effect，让 permission policy 决定请求授权或拒绝。

## PowerShell UTF-8

模型输入在权限前先经过：

```rust
fn normalize_input(&self, mut input: Value) -> Value {
    if command starts with the four known legacy UTF-8 setup statements {
        input["command"] = business_command_only;
    }
    input
}
```

被剥离的旧前缀：

```powershell
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
chcp 65001 > $null
```

授权和 effect parsing 只看业务命令。通过授权后，PowerShell host 在真正执行时由可信代码重新注入 UTF-8 setup。这样既保留中文输出，又不让 parser 面对多条框架前缀。

用户截图中 `npm run typecheck`、`check:architecture`、`build:renderer:tauri`、`cargo test` 和 `Get-Process` 全部被 runtime-policy 卡住，根因正是旧调用把 setup 与业务命令一起提交，出现 `shellunparsed`。当前 dirty change 的修正位置在 normalize 阶段，顺序是正确的：必须先归一化，再 plan effects/authorize。

## Reviewer 白名单

Reviewer 虽可见 Bash/PowerShell，但额外策略拒绝：

- background/task control
- 控制字符
- `; & | > < backtick $`
- 非显式验证命令

因此 Reviewer 只能执行单一、只读、可分类的验证命令，不能用管道或复合命令绕过限制。Explore 完全看不到 shell。

## 工作目录

ShellWorkspaceState 为 session 保存当前目录。路径仍必须在授权 workspace 内；清理 session 时同时清掉 remembered cwd 和 retained task authority。
