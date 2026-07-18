# Codex `exec` 与 Shell 工具

## `exec` 元工具

当前 Desktop 将多个底层工具放进一个受限 JavaScript isolate。模型发送 JavaScript，例如：

```js
const [a, b] = await Promise.all([
  tools.exec_command({ cmd: "rg --files", workdir: "..." }),
  tools.exec_command({ cmd: "git status --short", workdir: "..." })
]);
text(a.output);
text(b.output);
```

isolate 没有 Node 文件系统或网络，未 `await` 的 Promise 会被丢弃。`text()`、`image()`、`store/load()` 和 `yield_control()` 控制模型可见输出。这个设计把并发编排从 shell string 中移到结构化层。

## `exec_command`

除 `cmd/workdir/yield/max_output` 外，还支持：

- `sandbox_permissions` 与用户可见 `justification`。
- 可复用的 `prefix_rule`。
- `login`、`shell`、`tty`。
- 长命令返回 `session_id`，后续用 `write_stdin` 轮询或输入。

当前权限策略可能禁止任何 escalation；调用方必须遵守 session 的 permission profile，不能因为工具有字段就假设可提权。

## 长任务生命周期

```text
exec_command
-> 在 yield 窗口完成：直接返回 output/exit_code
-> 未完成：返回 session_id
-> write_stdin(chars="") 轮询，或写入交互输入
-> 最终 exit_code 后 session 关闭
```

独立 `wait(cell_id)` 用于等待由 `exec` yield 出来的执行 cell，不等于 OS process session。两类 ID 不应混用。

## Windows/PowerShell

日志中的失败不是 `npm`/`cargo` 测试失败，而是权限 runtime 无法完整分类前置 PowerShell：

```text
[Console]::InputEncoding = ...
[Console]::OutputEncoding = ...
$OutputEncoding = ...
chcp 65001 > $null
npm run typecheck
```

分类器把整段视为未知或 `shellunparsed`，所以命令未执行。正确架构是由可信 shell bootstrap 设置 encoding，模型工具参数只携带业务命令；至少也应把 bootstrap 与业务 AST 分开分类并在 UI 明示“未执行”。

## 输出与日志

`exec_command` 返回 output、exit_code、session_id、wall time 和原始 token 估计。模型看不到未转发的底层输出；`exec` 脚本需要显式 `text()`。这能减少噪声，也意味着审计日志必须同时保存底层原始结果和投影给模型的内容。
