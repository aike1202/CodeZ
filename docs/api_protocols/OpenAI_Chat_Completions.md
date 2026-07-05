# OpenAI Chat Completions API Format (完整规范)

OpenAI 的 `/v1/chat/completions` 是目前业界最通用的 LLM 接口协议，许多第三方大模型（如 DeepSeek, Qwen 等）都提供了完全兼容此格式的 API。

## 1. Request Body (请求体)

```json
{
  "model": "gpt-4o", // [必填] 模型名称
  "messages": [      // [必填] 消息列表
    {
      "role": "system",
      "content": "You are a helpful assistant."
    },
    {
      "role": "user",
      "content": "What's the weather like today?"
    }
  ],
  "temperature": 0.7,         // [选填] 采样温度 (0-2之间)，值越大越随机
  "top_p": 1.0,               // [选填] 核采样参数
  "n": 1,                     // [选填] 为每条输入消息生成多少个结果
  "stream": true,             // [选填] 是否使用 SSE 流式输出
  "stream_options": {         // [选填] 流式输出的附加选项（例如 include_usage）
    "include_usage": true
  },
  "stop": ["\n\n", "User:"],  // [选填] 停止词，最多4个
  "max_tokens": 2048,         // [选填] 最大生成的 token 数量 (旧版)
  "max_completion_tokens": 2048, // [选填] 最大生成的 token 数量 (新版推荐)
  "presence_penalty": 0.0,    // [选填] 存在惩罚 (-2.0 到 2.0)，惩罚已出现过的词
  "frequency_penalty": 0.0,   // [选填] 频率惩罚 (-2.0 到 2.0)，惩罚高频词
  "logit_bias": {             // [选填] 特定 token 的偏好设置
    "50256": -100
  },
  "response_format": {        // [选填] 指定响应格式 (例如 JSON)
    "type": "json_object"     // 或 "json_schema" (Structured Outputs)
  },
  "seed": 12345,              // [选填] 随机种子，用于尽量保证结果确定性
  "tools": [                  // [选填] 工具/函数调用列表
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather in a location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": { "type": "string" }
          },
          "required": ["location"]
        }
      }
    }
  ],
  "tool_choice": "auto",      // [选填] none / auto / required / 具体某个 tool
  "user": "user_id_123"       // [选填] 最终用户的唯一标识符
}
```

### 1.1 `messages` 详细结构

**支持的 Role**: `system`, `user`, `assistant`, `tool`

**User Role 复杂内容 (如视觉输入)**:
```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "What is in this image?" },
    { 
      "type": "image_url", 
      "image_url": { "url": "data:image/jpeg;base64,...", "detail": "high" }
    }
  ]
}
```

**Assistant Role (包含工具调用)**:
```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": "{\"location\": \"Beijing\"}"
      }
    }
  ]
}
```

**Tool Role (返回工具执行结果)**:
```json
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "Sunny, 25 degrees Celsius"
}
```

---

## 2. Response Body (响应体) - 非流式 (stream: false)

```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1677652288,
  "model": "gpt-4o-2024-05-13",
  "system_fingerprint": "fp_44709d6f20",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The weather today is sunny."
        // 如果触发了 tool call，这里会包含 "tool_calls" 数组，"content" 可能为空
      },
      "finish_reason": "stop" // 常见值: stop, length, tool_calls, content_filter
    }
  ],
  "usage": {
    "prompt_tokens": 9,
    "completion_tokens": 12,
    "total_tokens": 21
  }
}
```

---

## 3. Streaming Response (流式响应) - SSE 格式 (stream: true)

使用 SSE (Server-Sent Events) 返回，每行以 `data: ` 开头。

**流式数据块示例**:
```text
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"The"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":" weather"},"finish_reason":null}]}

// 最后一块，finish_reason 不为空
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

// 如果开启了 stream_options.include_usage，则会多一条包含 usage 的 chunk
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":12,"total_tokens":21}}

data: [DONE]
```

### 流式工具调用 Delta (Tool Call Streaming)
当发生函数调用时，`delta` 对象中会包含增量的 `tool_calls`。注意参数（`arguments`）是分片返回的 JSON 字符串片段，需要在客户端拼接。
```json
{
  "delta": {
    "tool_calls": [
      {
        "index": 0,
        "id": "call_abc",
        "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"" }
      }
    ]
  }
}
// 后续的 chunk
{
  "delta": {
    "tool_calls": [
      { "index": 0, "function": { "arguments": "location" } }
    ]
  }
}
```
