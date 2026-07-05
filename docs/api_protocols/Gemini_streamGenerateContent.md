# Gemini streamGenerateContent API Format (完整规范)

Google Gemini 的 REST API 端点设计独树一帜，大量使用了基于 RPC / Protobuf 映射风格的命名（如 camelCase 的属性名，复杂的层级嵌套）。它不叫 `messages` 而是 `contents`，不叫 `assistant` 而是 `model`。

- **非流式 API**: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- **流式 API**: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent`

## 1. Request Body (请求体)

```json
{
  "systemInstruction": {                  // [选填] System Prompt (单独立项)
    "parts": [
      { "text": "You are a helpful assistant." }
    ]
  },
  "contents": [                           // [必填] 历史对话记录
    {
      "role": "user",                     // 支持的 roles: "user" 或 "model"
      "parts": [                          // 内容分为多个 parts
        { "text": "What's the weather like in Tokyo?" }
      ]
    }
  ],
  "tools": [                              // [选填] 工具/函数定义
    {
      "functionDeclarations": [
        {
          "name": "get_weather",
          "description": "Get the current weather",
          "parameters": {
            "type": "OBJECT",             // 注意: Gemini 的类型全是大写 (如 TYPE_STRING, TYPE_OBJECT，但在较新 API 中也兼容小写 schema)
            "properties": {
              "location": { "type": "STRING" }
            },
            "required": ["location"]
          }
        }
      ]
    }
  ],
  "toolConfig": {                         // [选填] 工具调用控制
    "functionCallingConfig": {
      "mode": "AUTO"                      // ANY / AUTO / NONE
    }
  },
  "generationConfig": {                   // [选填] 生成参数被集中在一个对象内
    "temperature": 0.7,
    "topP": 0.95,
    "topK": 40,
    "maxOutputTokens": 2048,
    "stopSequences": ["\n\n"],
    "responseMimeType": "application/json" // 类似 OpenAI 的 response_format
  },
  "safetySettings": [                     // [选填] 安全拦截阈值
    {
      "category": "HARM_CATEGORY_HATE_SPEECH",
      "threshold": "BLOCK_ONLY_HIGH"
    }
  ]
}
```

### 1.1 `contents` 及 `parts` 详细结构

**文本与视觉 (Vision) 输入**:
```json
{
  "role": "user",
  "parts": [
    { "text": "Describe this image." },
    {
      "inlineData": {
        "mimeType": "image/jpeg",
        "data": "base64_encoded_string..."
      }
    }
  ]
}
```

**Model Role (带工具调用返回)**:
```json
{
  "role": "model",
  "parts": [
    {
      "functionCall": {
        "name": "get_weather",
        "args": { "location": "Tokyo" } // args 是 JSON 对象，非字符串
      }
    }
  ]
}
```

**User Role (返回工具执行结果)**:
```json
{
  "role": "user",
  "parts": [
    {
      "functionResponse": {
        "name": "get_weather",
        "response": { "temperature": 25, "condition": "Sunny" } // 任意 JSON object
      }
    }
  ]
}
```

---

## 2. Response Body (响应体) - 非流式

Gemini 会返回一个 `GenerateContentResponse` 结构。注意它使用了 `candidates` 数组（通常只有一个）。

```json
{
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [
          { "text": "The weather in Tokyo is sunny." }
        ]
      },
      "finishReason": "STOP", // 常见: STOP, MAX_TOKENS, SAFETY, RECITATION, OTHER
      "index": 0,
      "safetyRatings": [
        // 包含各个维度的安全评估得分
      ]
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 12,
    "candidatesTokenCount": 8,
    "totalTokenCount": 20
  }
}
```

---

## 3. Streaming Response (流式响应) - `streamGenerateContent`

流式的请求发送给 `streamGenerateContent` 接口（甚至可以加 `?alt=sse` 参数以标准 SSE 接收，或者默认返回一种 JSON Array 增量格式）。
在 Google 默认的实现中，它并不是每发出一个字就推送一次完整的 SSE event，而是推送完整的、包含部分增量内容的 `GenerateContentResponse` 对象的 JSON Chunk。

如果你以标准 HTTP 分块传输（或SSE）接收，每一个 chunk 实际上是一个结构完全类似于非流式响应的 JSON 块。

```json
// Chunk 1
{
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [{"text": "The weather"}]
      }
    }
  ]
}
// Chunk 2
{
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [{"text": " in Tokyo is sunny."}]
      },
      "finishReason": "STOP"
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 12,
    "candidatesTokenCount": 8,
    "totalTokenCount": 20
  }
}
```
*客户端处理：*需要遍历每个 chunk 里的 `candidates[0].content.parts` 并拼接文本（或拼接 Function Call 参数）。
