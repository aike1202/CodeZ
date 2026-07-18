# 08 附件、状态、提醒与压缩

## 附件

Codex user message 可包含图片、本地文件或 app resource。Rollout 保存 content part 或引用；敏感/大型二进制不应直接复制进研究仓库。

## 状态与提醒

- `world_state`：skills/plugins/environment 等宿主状态。
- `turn_context`：model/effort/approval/sandbox/git/context window。
- Agent mailbox update 和 completion status。
- command/patch lifecycle events。
- plan/goal 状态。

这些记录不全是普通模型消息。每项必须标记 `model_visible`、`runtime_only` 或 `projection_unknown`。

## Compaction

Base instructions 说明上下文耗尽时会自动总结并继续，但本次调研没有获得 Codex 服务端 compaction 算法或 cache block 实现。Rollout 可出现摘要/后续 messages，但不能据此声称完整知道保留策略。

## Thread/Resume

主 task、用户可见 thread 和 SubAgent child thread 都有独立历史。`read_thread` 返回摘要/截断 output，不等于读取完整原始 rollout；follow-up 会继续原 thread 设置和历史。
