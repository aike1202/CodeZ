# Rust PTY 与进程树 capability spike

> 状态：Windows 部分通过；原生前台命令 Ctrl+C 仍阻断，macOS/Linux runtime smoke 待执行
>
> 日期：2026-07-15
>
> 候选：WezTerm `portable-pty = 0.9.0`

## 目的

用真实 Windows ConPTY 验证 Phase 3 所需的 terminal start/write/resize/kill/output/exit 基础能力和进程树清理责任，而不是只验证 crate 能否编译。`portable-pty` 已进入 `codez-platform` 生产依赖，测试同时覆盖底层原语和生产 `PtyManager` 的树级终止路径；Electron `TerminalService` 仍保留为迁移基线。

## 方法

可执行证据位于 `crates/codez-platform/tests/portable_pty_spike.rs`：

1. 通过 `native_pty_system()` 创建 80x24 ConPTY，并启动 UTF-8 PowerShell。
2. 模拟 xterm.js 响应首次 `ESC[6n` 光标查询，解除 ConPTY 启动握手。
3. 读取真实 PTY 字节流，验证中文输出和中文工作目录。
4. resize 到 132x41，同时验证 master 报告值和 PowerShell `RawUI.WindowSize`。
5. 对原生 `ping.exe -t` 前台命令写入字节 `0x03`，要求恢复 prompt 后能执行下一条命令；该验收目前稳定失败。
6. 通过生产 `PtyManager.kill` 终止包含隐藏后代进程的终端树；后代先报告 PID 并持有独占文件锁，终止后验证文件锁释放且 terminal registry 归零。
7. 正常 `exit 0` 后关闭 writer/child/master，验证 reader 收到 EOF 且 reader thread 被 join。
8. 提供 Unix 条件编译 smoke，覆盖 resize、Ctrl+C 和 clean exit；本轮 Windows 环境不将其计为通过。

探针输出使用 64 槽有界 channel，最多累计 256 KiB；每项等待上限 10 秒。失败路径通过 `Drop` 尝试树级终止、直接 child kill、句柄关闭和 reader join，避免测试留下 shell。

## 结果

| 能力 | Windows 结果 | 结论 |
| --- | --- | --- |
| ConPTY 创建与 PowerShell 启动 | 通过 | `portable-pty` 的 Windows native backend 可用。 |
| 首次光标查询 | 发现强制握手 | ConPTY 先输出 `ESC[6n` 并等待位置响应；Tauri 流必须保留 xterm.js 双向控制序列。 |
| UTF-8 与中文 cwd | 通过 | UTF-8 PowerShell 初始化后，中文输出和中文路径均保持。 |
| resize | 通过 | 132x41 同时对 master 和 shell 可见。 |
| Ctrl+C | **失败，发布阻断** | ConPTY 中向原生 `ping.exe -t` 写入裸 `0x03` 后，前台进程继续运行，shell 无法恢复并执行后续命令。不得把 PowerShell 脚本或可自行处理 ETX 的程序结果外推为通用 Ctrl+C。 |
| clean exit / reader EOF | 通过 | shell 退出、PID 消失、reader EOF 和线程 join 均完成。 |
| kill tree | 通过生产适配验证 | `PtyManager.kill` 清除已识别后代，释放后代持有的独占文件锁，并把 registry 降为 0。 |
| 有界输出 | 通过探针约束 | 测试不会无限积累输出；Phase 3 仍需为用户终端定义背压与迟到事件策略。 |
| macOS/Linux | 未运行 | 条件编译 smoke 已存在，必须在目标 CI/真机执行。 |

## 决策

`portable-pty 0.9.0` 仍可承担跨平台 PTY 创建、读写和 resize 原语，但当前证据不足以确认它单独满足 Windows Ctrl+C 语义。CodeZ 已在其外部实现：

- `TerminalRegistry` 和 terminal ID 生命周期。
- blocking reader/writer owner 与有界 output channel。
- Windows Job Object 树级终止、Unix process group/session 终止和退出确认。
- 稳定错误码、幂等 kill、单次 exit 事件和迟到输出丢弃。
- shell/UTF-8 环境选择、工作目录校验和 app shutdown 全量回收。
- Tauri channel 与 xterm.js 间严格有序的双向控制序列。

Windows Ctrl+C 在 ADR 明确选择并验证 control-event helper、sidecar 或替代 PTY 核心之前保持 Phase 3 阻断；不得弱化真实原生命令测试。该选择不表示 Phase 3 已完成。

## 验证

2026-07-15 Windows x64，Rust 1.95.0：

```powershell
cargo test -p codez-platform --test portable_pty_spike -- --test-threads=1
cargo clippy -p codez-platform --all-targets --all-features --locked -- -D warnings -D clippy::perf
```

2026-07-16 在当前 lockfile 上执行的聚焦复验：`windows_supervisor_should_kill_the_shell_process_tree` 通过（1/1，0.41 秒）；`windows_conpty_should_deliver_ctrl_c_to_the_foreground_command` 在 10.11 秒后失败（0/1），捕获输出显示 `ping.exe -t` 仍持续运行且没有 `CODEZ_AFTER_CTRL_C`。其余 Windows ConPTY 用例此前通过，Unix smoke 未在本机执行。严格 Clippy 与完整平台测试需在 Ctrl+C 方案确定后重新作为统一门禁执行。

## 限制

- `portable-pty` 没有异步 API，生产实现需要显式隔离阻塞 I/O。
- crate 没有声明 MSRV；工作区要求的 Rust 1.85 兼容性仍需 CI 验证。
- Windows 树级终止已走生产 `PtyManager.kill`，但仍需补 PID owner 校验、并发 kill 和应用退出竞态测试。
- Windows 原生控制台程序不能依赖裸 ETX 获得通用 Ctrl+C；是否引入 Rust control-event helper/sidecar 或更换 PTY 核心必须先形成 ADR。
- 本轮未测高吞吐与慢消费者；这些属于独立 Tauri 流/backpressure spike。
- 本轮未测 shell parser 或权限语义；PTY 只传输已经获准启动的 shell 字节流。
