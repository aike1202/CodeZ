# ADR 0005: Tauri 高频流背压与取消协议

> 状态：Accepted
>
> 日期：2026-07-16

## 背景

Chat、Agent、Tool 和 Terminal 会持续向 React WebView 发送高频增量。Tauri `Channel` 提供 typed transport 和发送顺序，但不是有界消息队列，也无法感知 React 组件是否仍在消费。

在 Tauri 2.11.5 中，小 JSON 通过 `webview.eval` 发送；8 KiB 以上 JSON 会进入 Tauri 内部 `ChannelDataIpcQueue`，等待前端 fetch。连续发送大 payload 或不限制在途数量可能让 Rust/WebView transport 内存持续增长。JavaScript `Channel` 被丢弃也不会自动取消后端任务。

## 决策

高频业务流使用 Tauri `Channel` 作为 wire transport，并在 CodeZ 应用层实现以下协议：

- runtime producer 先写入有界上游队列；队列满时等待、合并允许合并的文本增量，或以过载终态结束，禁止静默丢关键事件。
- 文本/终端 delta 批处理为不超过 4 KiB payload 的 frame，给 JSON envelope 留出余量，避免依赖 Tauri 的大 payload fetch queue。
- 每个 frame 使用单流单调递增 `sequence`，前端通过独立 command 返回累计 ACK。
- 初始最大在途窗口为 4 个 frame；未收到 ACK 时停止从上游继续发送到 Tauri Channel。具体容量可按真实基线调整，但必须有固定上限和回归证据。
- 组件卸载、会话切换和用户停止必须调用幂等 cancel command。前端清理 `onmessage` 后不能只依赖 JavaScript GC。
- ACK channel 关闭与 cancel 可能竞态；后端观察到 ACK 断开时再次检查 cancel，将已确认卸载分类为 `interrupted`。
- 后端是流状态 owner。监听器存在时发送且仅发送一个 `completed | failed | interrupted` 终态；监听器已卸载时仍在后端提交终态和清理任务，不要求向已关闭 Channel 强送事件。
- 审批、工具边界、Usage、错误和终态不可与文本 delta 一起丢弃或覆盖。

Phase 0 只验证协议模型；具体 Chat/Terminal registry、ACK/cancel commands 和前端 reducer 在对应迁移阶段实现。

## 后果

- Tauri Channel 的成功返回只代表 transport callback 接受 frame，不代表 React 已消费；只有累计 ACK 推进消费窗口。
- 每个流需要 ACK 超时和取消宽限期，超时后不能继续累积在途数据。
- 前端 reducer 可以按 frame 批量更新，避免每个 token 触发 React render。
- 4 KiB/4 frame 是首轮保守值；升级 Tauri、改变 envelope 或性能调优时必须重新运行 stream spike。
- 二进制附件、大文件和完整工具输出不通过高频 delta channel 直接传输，继续使用句柄/分页/受限读取。
- 真实 WebView IPC 延迟与平台差异仍需后续无截图集成/CI 验证；本 ADR 不以 UI 截图作为正确性证据。

验证证据见 `docs/migration/spikes/tauri-stream-backpressure.md`。
