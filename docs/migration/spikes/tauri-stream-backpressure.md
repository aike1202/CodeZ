# Tauri 高频流与背压 spike

> 状态：协议模型通过，真实 WebView 延迟待平台集成
>
> 日期：2026-07-16
>
> Tauri：2.11.5

## 目的

验证聊天/终端高频事件在慢消费者和组件卸载场景下的顺序、取消、背压、终态和内存上限。测试使用真实 `tauri::ipc::Channel` 序列化入口，不启动窗口、不做截图。

## Tauri transport 结论

对 Tauri 2.11.5 源码检查确认：

- `Channel::send` 同步调用 transport callback，不维护应用级消费 ACK。
- 小于 8 KiB 的 JSON 直接执行 WebView callback。
- 更大 payload 存入内部 `ChannelDataIpcQueue<HashMap<...>>`，再由 JavaScript fetch。
- Rust Channel drop 可以执行 Rust `on_drop`，但从 command 参数创建的 JavaScript Channel 没有组件卸载自动取消语义。

因此 Tauri Channel 可保证单 sender 调用顺序，但不能单独证明慢 React 消费时内存有界。

## 验证模型

可执行证据位于 `src-tauri/tests/tauri_stream_spike.rs`：

- 上游使用容量 16 的同步有界队列，每个 chunk 固定 128 bytes。
- delta 合并为最大 4 KiB payload，序列化 JSON 必须保持在 8 KiB 以下。
- Tauri Channel 发送窗口最多 4 个未 ACK frame。
- mock frontend 每个 frame 延迟 1 ms，按 sequence 验证所有 chunk，并返回累计 ACK。
- 第二个场景在第 3 个 frame 后模拟组件卸载：发送 cancel、关闭 ACK sender 和 Channel consumer。

## 结果

| 能力 | 结果 | 证据 |
| --- | --- | --- |
| 高吞吐 | 通过 | 20,000 x 128 bytes，共 2.56 MiB 持续数据完整消费。 |
| 单流顺序 | 通过 | frame sequence 和 chunk index 均连续，无重复/跳号。 |
| 慢消费者背压 | 通过 | 最大在途 frame 不超过 4，生产者受 ACK 窗口限制。 |
| transport frame 上限 | 通过 | 所有序列化 JSON 均小于 8 KiB，避免大 payload queue。 |
| 应用侧内存上限 | 通过 | 上游、当前 batch 和在途窗口的保守上界低于 64 KiB。 |
| 正常终态 | 通过 | 完整流只收到一个 `completed`。 |
| 组件卸载 | 通过 | 第 3 frame 后 cancel，生产者在 20,000 chunk 前停止并解除阻塞。 |
| ACK/cancel 竞态 | 通过 | ACK sender 先关闭时复查 cancel，结果归类为 `interrupted`。 |
| 卸载后终态 | 通过 | 后端记录一个 `interrupted`；不向已关闭 UI Channel 强送终态。 |

运行：

```powershell
cargo test -p codez-desktop --test tauri_stream_spike --locked -- --test-threads=1
```

2 个必要的流行为测试全部通过。

## 决策边界

- 本轮验证应用层 ACK window 模型，不新增临时 UI 或开发页面。
- Phase 4/8 实现真实 Chat stream 时，start response 返回 `streamId`，ACK/cancel 都按 stream ID 幂等处理。
- Terminal 使用同一 frame/window 协议，但 binary/ANSI 字节分块不得破坏 UTF-8 或控制序列边界；该细节在 Phase 3 实现中验证。
- 真实 WebView2/WebKit IPC 性能、后台窗口节流和进程内存需要平台 CI/基准，不由本线程模型测试替代。
- Tauri 内部 8 KiB threshold 不是稳定公共 API；升级 Tauri 必须重新检查并运行本 spike。
