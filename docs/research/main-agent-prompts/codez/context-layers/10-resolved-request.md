# 10 最终解析请求

## OpenAI-compatible 请求形状

```json
{
  "model": "gpt-5.6-sol",
  "messages": [
    { "role": "system", "content": "<展开后的完整 CodeZ prompt>" },
    { "role": "user", "content": "<当前用户请求>" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "<tool name>",
        "description": "<descriptor description>",
        "parameters": { "type": "object" }
      }
    }
  ],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

当前 model 未配置 `maxOutputTokens`，所以 OpenAI adapter 不发送 output limit。`thinking: enabled/auto/auto` 也不会产生额外 request 字段。

## 适配差异

Anthropic 会把所有 system-role messages 合并到顶层 `system`，普通消息进入 `messages`，tools 使用 `input_schema`，并强制给出 `max_tokens`。

Gemini 会把 system-role messages 变为 `systemInstruction.parts`，tools 变为 `functionDeclarations`，其余 history 进入 `contents`。

## 完整样例

`context-requests/01-real-ledger-source-reconstructed.md` 和 `02-real-explore-agent-reconstructed.md` 都直接嵌入完整 System、messages 和 tool schemas。`03-reviewer-source-derived.md` 是 D 级模拟，明确不冒充真实 Reviewer 抓包。
