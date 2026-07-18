# 09 当前用户请求

## 内容形式

当前请求是本轮最后的 user content，可包含 text、image、document 和运行时 attachment。它与历史用户消息不同：主 Agent 必须以最新请求判断是替换旧任务、追加要求还是状态询问。

选定真实首轮内容：

```json
{
  "role": "user",
  "content": [
    { "type": "image", "source": "[REDACTED_BASE64_SCREENSHOT]" },
    { "type": "text", "text": "出现Accept all点击没有反应的情况" }
  ]
}
```

## 与目录附件的顺序

真实记录中 user request 后紧接初始 Agent/Skill listing attachments，再由 assistant 选择 Skill。目录不是用户原文，但在同一首轮推理上下文中影响行为。

## 记录要求

保存原始 content block 类型、顺序、附件 hash/mime、接收时间、queued/steered 状态和脱敏版本。不能只保存拼接后的纯文本，否则图片和动态附件关系会丢失。
