# 09 当前用户请求

CodeZ 没有 Grok Build 那样的首条 user prefix。环境、Git、规则和工具目录主要放进 System Prompt，用户输入保持原文。

真实会话 `1784299678287_8eao9s` 的首条 user message 是：

```json
{
  "role": "user",
  "content": "这是什么项目"
}
```

对应 Ledger 还保存：

```yaml
contextScopeId: main
providerId: pv_019f6fae4e957b4292228e0bb32182eb
model: m_1784285065604_bmdh
turnId: stream_1784299685900_g3jgd8he
createdAt: 2026-07-17T14:48:05.929769900Z
```

如果输入是 Agent mailbox：

- `new_task` 直接使用 payload 作为 user content。
- 普通 message 包装为 `Message from <author>:\n\n<payload>`。
- final answer 包装为 `Final answer from <author>:\n\n<payload>`。

因此 CodeZ 的“首条 user prefix”答案是：主会话没有固定 prefix；子 Agent 的首条 user message 是 Durable mailbox payload，附加元数据保存在 ledger payload 中而不是正文前缀。
