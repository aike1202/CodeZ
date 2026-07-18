# 当前 Durable Agent 工具与父子协议

## `spawn_agent`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["role", "taskName", "message"],
  "properties": {
    "role": { "type": "string", "enum": ["Explore", "Reviewer"] },
    "taskName": { "type": "string", "minLength": 1, "maxLength": 64, "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
    "description": { "type": "string", "maxLength": 4096 },
    "message": { "type": "string", "minLength": 1, "maxLength": 131072 },
    "context": { "type": "string", "minLength": 1, "maxLength": 262144 },
    "expectations": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "questions": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
        "outOfScope": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } }
      }
    },
    "scope": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "directories": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
        "excludeGlobs": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } }
      }
    },
    "depth": { "type": "string", "enum": ["quick", "normal", "exhaustive"] },
    "allowedWriteFiles": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
    "allowShell": { "type": "boolean" }
  }
}
```

输出：

```json
{
  "agent": {
    "agentId": "agent_<uuid>",
    "attemptId": "attempt_<uuid>",
    "contextScopeId": "subagent:agent_<uuid>",
    "path": "/root/<taskName>",
    "parentPath": "/root",
    "role": "Explore",
    "status": "queued | running | completed | failed | interrupted",
    "launch": {}
  }
}
```

## 其余工具

`followup_task` 和 `send_message`：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["target", "message"],
  "properties": {
    "target": { "type": "string", "minLength": 1, "maxLength": 512 },
    "message": { "type": "string", "minLength": 1, "maxLength": 131072 }
  }
}
```

`list_agents`：

```json
{ "type": "object", "additionalProperties": false, "properties": {} }
```

`wait_agent`：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "targets": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 512 } },
    "timeoutMs": { "type": "integer", "minimum": 0, "maximum": 300000 }
  }
}
```

`interrupt_agent`：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["target"],
  "properties": { "target": { "type": "string", "minLength": 1, "maxLength": 512 } }
}
```

## 权限边界

`allowedWriteFiles` 和 `allowShell` 已进入 launch schema，但当前 role tool policy 是硬 allowlist：Explore 无 shell/写工具，Reviewer 只有 shell 验证，无写工具。因此这两个字段目前不能把任何 child 升级为 Executor。

Reviewer shell 还会拒绝：控制字符、`; & | > < backtick $`、后台任务、task control，以及不在验证命令白名单中的首个 token。即使 workspace 是 full-access，也不能绕过此 Agent policy。
