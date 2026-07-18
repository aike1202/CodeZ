# 08 附件、提醒与压缩摘要

## 图片附件

用户图片先由 AttachmentService 持久化和验证，history 只保存 session attachment identity。Provider request 准备阶段才按 API 格式解析并注入 image data。System message 不允许带图片；单次 chat 最多 500 个 image attachments。

## 当前输入前的插入顺序

若对应状态存在，在当前 user message 之前插入：

```text
post-compaction skill context   assistant role
session skill state             assistant role
post-compaction file context    assistant role
current user input              user role
```

这些不是主 System Prompt 的一部分，却同样会占用上下文并改变模型行为。

## Compaction

ContextBudgetService 同时计算：

```text
system prompt
tool schemas
instruction fragments
summary / resume
recent history
current input
attachments
reasoning and output reserve
```

压力达到 Prune/Compact/Overflow 时先修剪旧工具结果；Compact/Overflow 可触发一次自动 compaction，再从 durable snapshot 重新准备请求。当前 `MAX_CONTEXT_PREPARATION_ATTEMPTS = 2`。

## Reminder 的对应物

CodeZ 没有通用 `<system-reminder>` 消息类型。最接近的机制是：

- active skill state
- post-compaction skill/file context
- resume state
- 每轮重建的动态 System Prompt
- Agent mailbox message

当前 selected session 没有 compaction，但主 scope 在激活 `using-superpowers` 后保存了完整 skill body；这会显著增加后续请求输入。
