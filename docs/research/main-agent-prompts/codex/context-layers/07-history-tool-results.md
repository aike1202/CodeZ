# 07 用户消息、会话历史与工具结果

## Rollout Record

Codex JSONL 用 `response_item` 保存 developer/user/assistant message、reasoning、function/custom tool call 和 output；`event_msg` 保存 commentary、token count、patch/command/Agent lifecycle。

## 模型历史

下一轮通常需要此前 message、tool call 和 tool result，直到 context management 执行压缩或裁剪。Reasoning 的 summary 可见，但 encrypted content 无法从日志解密。

## 工具结果投影

`exec` 只有显式 `text()`/`image()` 的内容回到模型；底层 `exec_command` 返回可能比投影更完整。`apply_patch` 的模型结果可很短，但 rollout 另外保存结构化 file diff。

## 子 Agent

Child 有独立 rollout。Parent mailbox 接收 final/status，不应把 child 所有中间输出复制进主 history。`fork_turns` 决定 child 初始继承多少父历史。

## 日志要求

保存 raw result、model projection、truncation、artifact reference、call linkage、token usage 和 child/parent ownership，避免把 UI output 与模型实际输入混为一谈。
