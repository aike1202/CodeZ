# 07 用户消息、会话历史与工具结果

## Conversation

首轮 user message 由 prefix + `<user_query>` 组成，之后是 assistant tool calls、tool outputs、assistant text 和新的 user prompts。Tool output 有内部结构和 `to_prompt_format()` 投影两层。

## 结果示例

- Read：格式化行内容和 media content parts。
- Grep：workspace result/card body、match summary 和 truncation notice。
- SearchReplace：短成功消息加内部 edit context/FileWritten notification。
- Bash：exit header、预算内 output、完整 output file 和 background notification。
- Task：child final writeup 加 `<subagent_meta>/<subagent_result>`。

## 流式内容

Read/Grep/Bash 可发送 progress delta，terminal output 再给最终结构。模型是否接收每个 progress event 取决于 host；审计要区分 UI stream、model history 和最终 result。

## Context 成本

大工具输出应通过 output file/artifact 保存，只将摘要投影给模型。SubAgent 的独立 history 不应整体复制回 parent。
