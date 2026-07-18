# 07 用户消息、会话历史与工具结果

## 消息结构

典型循环：

```text
user content blocks
assistant text/reasoning + tool_use
user tool_result matched by tool_use_id
assistant next turn
```

图片、文本和附件可共存于 user message。工具调用参数本身也保留在 assistant history，例如 Edit 的 old/new string 会继续占用上下文。

## 工具结果

- Read：模型看到带行号内容，UI 可以只显示摘要。
- Edit：模型只看到成功短消息，但 assistant tool call 保留 patch 参数；完整 diff 在内部 metadata。
- Grep/Bash：大结果可能只投影预览并给出持久化文件路径。
- Agent：父 Agent接收最终报告/notification，不应自动拼入完整 child transcript。

## 增长与清理

工具结果通常是增长最快的层。Microcompact 可把较旧 compactable tool result 替换为 cleared marker；传统 compact 用 summary 取代早期历史。未清理前，每次模型请求仍会携带相关消息或使用服务端缓存引用。

## 审计要求

同时保存原始 tool result、模型可见投影、是否截断、artifact path/hash 和清理事件。否则无法区分“工具产生很多输出”与“模型实际看到很多输出”。
