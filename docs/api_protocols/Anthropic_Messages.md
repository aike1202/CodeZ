# Anthropic Messages API Format (完整规范)

Anthropic 的 `/v1/messages` 接口专门为 Claude 模型设计。它在结构上与 OpenAI 类似，但在一些关键设计（如 System Prompt 位置、内容块格式、流式事件生命周期）上有严格的区分。

## 1. Request Body (请求体)

```json
{
  "model": "claude-3-5-sonnet-20241022", // [必填] 模型名称
  "max_tokens": 1024,                    // [必填] 强制要求，最大生成的 token 数量
  "system": "You are a helpful assistant.", // [选填] 系统提示词，不要放在 messages 数组里
  "messages": [                          // [必填] 消息列表 (必须以 user 开始，严格交替 user 和 assistant)
    {
      "role": "user",
      "content": "What's the weather like today?"
    }
  ],
  "temperature": 1.0,                    // [选填] 采样温度 (0-1)
  "top_p": 0.9,                          // [选填] 核采样
  "top_k": 40,                           // [选填] 截断采样
  "stop_sequences": ["\n\nHuman:"],      // [选填] 自定义停止序列
  "stream": true,                        // [选填] 是否流式输出
  "metadata": {                          // [选填] 用户元数据
    "user_id": "user_123"
  },
  "tools": [                             // [选填] 工具定义
    {
      "name": "get_weather",
      "description": "Get current weather",
      "input_schema": {                  // 注意：这里是 input_schema 而不是 OpenAI 的 parameters
        "type": "object",
        "properties": {
          "location": { "type": "string" }
        },
        "required": ["location"]
      }
    }
  ],
  "tool_choice": {                       // [选填] 控制工具调用
    "type": "auto"                       // 也支持 "any" 或 "tool" (指定特定工具)
  }
}
```

### 1.1 `messages` 详细结构与内容块

在 Anthropic 中，`content` 经常是以对象数组形式出现（Content Blocks）。

**User 包含文本和图片**:
```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "What is in this image?"
    },
    {
      "type": "image",
      "source": {
        "type": "base64",
        "media_type": "image/jpeg",
        "data": "/9j/4AAQSkZJRg..."
      }
    }
  ]
}
```

**Assistant 返回工具调用**:
```json
{
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "I will check the weather for you."
    },
    {
      "type": "tool_use",
      "id": "toolu_01A09q90qw90lq",
      "name": "get_weather",
      "input": { "location": "Beijing" } // 注意：这里是一个完整的 JSON 对象，而不是 OpenAI 的字符串
    }
  ]
}
```

**User 返回工具执行结果**:
在 Anthropic 规范中，**没有**独立的 `tool` role。工具结果也是通过 `user` 发送，类型为 `tool_result`。
```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01A09q90qw90lq",
      "content": "Sunny, 25 degrees", // 可以是字符串，或者是嵌套的 content blocks 数组
      "is_error": false               // 如果工具执行出错，可设为 true
    }
  ]
}
```

---

## 2. Response Body (响应体) - 非流式 (stream: false)

```json
{
  "id": "msg_01XFDawX19A",
  "type": "message",
  "role": "assistant",
  "model": "claude-3-5-sonnet-20241022",
  "content": [
    {
      "type": "text",
      "text": "The weather today is sunny."
    }
    // 如果调用了工具，这里会包含 type: "tool_use" 的块
  ],
  "stop_reason": "end_turn", // 常见值: end_turn, max_tokens, stop_sequence, tool_use
  "stop_sequence": null,
  "usage": {
    "input_tokens": 15,
    "output_tokens": 8
  }
}
```

---

## 3. Streaming Response (流式响应) - SSE 格式 (stream: true)

Anthropic 的流式响应是一个基于状态机生命周期的严谨设计，包含一系列具体的事件 (Event Types)。

**流式事件示例**:
```text
// 1. 消息开始
event: message_start
data: {"type": "message_start", "message": {"id": "msg_123", "type": "message", "role": "assistant", "model": "claude-3", "usage": {"input_tokens": 15, "output_tokens": 1}}}

// 2. 内容块开始 (e.g. text 块)
event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}

// 3. 内容块增量
event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "The "}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "weather"}}

// 4. 内容块结束
event: content_block_stop
data: {"type": "content_block_stop", "index": 0}

// 如果触发工具调用，会开启新的块: content_block_start (type: tool_use)
// 接着是 content_block_delta (type: input_json_delta, 包含 partial_json)

// 5. 消息增量 (更新停止原因和用量)
event: message_delta
data: {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": null}, "usage": {"output_tokens": 8}}

// 6. 消息结束
event: message_stop
data: {"type": "message_stop"}
```
