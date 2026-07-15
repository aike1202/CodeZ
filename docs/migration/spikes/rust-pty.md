# Rust PTY 与进程树 capability spike

> 状态：Windows 通过，macOS/Linux runtime smoke 待执行
>
> 日期：2026-07-15
>
> 候选：WezTerm `portable-pty = 0.9.0`

## 目的

用真实 Windows ConPTY 验证 Phase 3 所需的 terminal start/write/resize/kill/output/exit 基础能力和进程树清理责任，而不是只验证 crate 能否编译。Spike 不替换 Electron `TerminalService`，`portable-pty` 当前仅是 `codez-platform` 的 dev dependency。

## 方法

可执行证据位于 `crates/codez-platform/tests/portable_pty_spike.rs`：

1. 通过 `native_pty_system()` 创建 80x24 ConPTY，并启动 UTF-8 PowerShell。
2. 模拟 xterm.js 响应首次 `ESC[6n` 光标查询，解除 ConPTY 启动握手。
3. 读取真实 PTY 字节流，验证中文输出和中文工作目录。
4. resize 到 132x41，同时验证 master 报告值和 PowerShell `RawUI.WindowSize`。
5. 在无限前台命令运行时写入字节 `0x03`，等待新 prompt 后执行下一条命令。
6. 启动隐藏的后代 PowerShell，以根 shell PID 执行树级终止，并确认根进程与后代 PID 都消失。
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
| Ctrl+C | 通过 | 写入 `0x03` 可中断前台循环并恢复 prompt。 |
| clean exit / reader EOF | 通过 | shell 退出、PID 消失、reader EOF 和线程 join 均完成。 |
| kill tree | 通过适配验证 | `taskkill /T /F` 清除根 shell 与隐藏后代；crate 的直接 child kill 不能替代 supervisor。 |
| 有界输出 | 通过探针约束 | 测试不会无限积累输出；Phase 3 仍需为用户终端定义背压与迟到事件策略。 |
| macOS/Linux | 未运行 | 条件编译 smoke 已存在，必须在目标 CI/真机执行。 |

## 决策

Phase 3 使用 `portable-pty 0.9.0` 作为跨平台 PTY 原语，不自研 ConPTY/Unix PTY FFI。CodeZ 在其外部实现：

- `TerminalRegistry` 和 terminal ID 生命周期。
- blocking reader/writer owner 与有界 output channel。
- Windows 树级终止、Unix process group/session 终止和退出确认。
- 稳定错误码、幂等 kill、单次 exit 事件和迟到输出丢弃。
- shell/UTF-8 环境选择、工作目录校验和 app shutdown 全量回收。
- Tauri channel 与 xterm.js 间严格有序的双向控制序列。

该选择不表示 Phase 3 已完成；它只关闭 Windows PTY 原语是否可用的 Phase 0 风险。

## 验证

2026-07-15 Windows x64，Rust 1.95.0：

```powershell
cargo test -p codez-platform --test portable_pty_spike -- --test-threads=1
cargo clippy -p codez-platform --all-targets --all-features --locked -- -D warnings -D clippy::perf
```

6 个 Windows ConPTY/进程树测试全部通过，严格 Clippy 与性能 lint 通过。Unix smoke 未在本机执行。

## 限制

- `portable-pty` 没有异步 API，生产实现需要显式隔离阻塞 I/O。
- crate 没有声明 MSRV；工作区要求的 Rust 1.85 兼容性仍需 CI 验证。
- Windows 树级终止探针使用系统 `taskkill`；Phase 3 必须补 PID owner 校验、并发 kill 和应用退出竞态测试。
- 本轮未测高吞吐与慢消费者；这些属于独立 Tauri 流/backpressure spike。
- 本轮未测 shell parser 或权限语义；PTY 只传输已经获准启动的 shell 字节流。
