# ADR 0003: Rust PTY 与进程树责任边界

> 状态：Accepted（Windows Ctrl+C 交付策略仍为未决后续 ADR）
>
> 日期：2026-07-15

## 背景

Phase 0 要求先验证 Windows ConPTY、中文、resize、Ctrl+C、进程树终止和退出清理，再决定 Phase 3 的 Rust PTY 实现。现有 Electron 终端使用 `node-pty`，前端继续使用 xterm.js，因此 Rust 方案必须保持双向终端字节流和现有 start/write/resize/kill/output/exit 语义。

## 决策

Phase 3 采用固定版本 `portable-pty 0.9.0` 作为 PTY 原语。它负责创建原生 PTY、启动 shell、输入输出句柄、窗口尺寸和直接子进程状态，不负责 CodeZ 的终端 registry、事件背压、取消树或完整进程树终止。

CodeZ 保留以下平台适配责任：

- `TerminalRegistry` 是 terminal ID、PTY owner、退出状态和 shutdown 回收的唯一权威来源。
- 阻塞 reader/writer 必须运行在受 owner 管理的 blocking task 或专用线程中，输出进入有界 channel；禁止 fire-and-forget。
- Windows ConPTY 启动时的 `ESC[6n` 光标位置查询和 xterm.js 的 `ESC[row;colR` 响应必须原样双向传递，不能被 command/event adapter 过滤或重排。
- `portable-pty::Child::kill()` 只终止直接子进程。Windows 使用经过集成测试的树级终止 adapter，macOS/Linux 使用进程组/session 终止，并在返回前确认后代进程退出。
- 终端关闭按 writer、child、master、reader owner 的确定顺序收尾，并产生一次稳定 exit 事件；重复 kill 和迟到输出必须幂等处理。
- crate 暴露的 `anyhow::Error` 不进入 CodeZ 公共 API；`codez-platform` 将错误映射为 `thiserror` 定义的稳定平台错误。

`portable-pty` 在 Phase 0 仅作为 `codez-platform` 的 dev dependency；Phase 3 开始生产实现时再提升为普通 dependency。

## 后果

- Windows x64 已用真实 ConPTY 验证 UTF-8、中文工作目录、132x41 resize、隐藏后代进程树终止、clean exit 和 reader EOF。原生 `ping.exe -t` 前台命令的 Ctrl+C 验收失败：写入裸 `0x03` 后 shell 不能恢复，不得声称 Ctrl+C 已验证。
- 现有 `TerminalInstance` 的 xterm.js output -> `term.write()` -> `onData` -> backend write 回路必须在 Tauri channel 迁移中保持，否则 ConPTY 可能停在首次光标查询。
- `portable-pty` 是同步阻塞接口；Phase 3 不能在 Tokio async worker 上直接阻塞读取，也不能使用无界输出队列。
- Windows 树级终止现在经生产 `PtyManager.kill` 验证：受测后代报告 PID、持有独占文件锁，kill 后锁释放且 registry 为零。这不免除 PID owner 校验、并发 kill 和退出竞态测试。
- macOS/Linux 条件编译 smoke 已加入测试源码，但尚未在真实平台运行，不能据此宣称平台验收完成。
- 依赖未声明 MSRV；当前证据来自 Rust 1.95.0。工作区 Rust 1.85 门禁仍需由 CI 单独验证。

验证证据见 `docs/migration/spikes/rust-pty.md`。

## Windows Ctrl+C 后续 ADR

本 ADR 只固定 `portable-pty` 的创建、读写、resize 和树级终止责任边界，不授权把裸 ETX 当作 Windows 通用 Ctrl+C。Phase 3 退出前必须新增或更新 ADR，选择并在真实原生前台程序上验证下列之一：受控的 Windows control-event helper/sidecar，替代 PTY 核心，或另一种能保持现有终端字节流语义的方案。该 ADR 必须同时规定进程归属、权限边界、取消超时、清理/回收、打包方式和失败时的安全行为；不得通过弱化 `ping.exe -t` 复验来关闭该阻断项。
