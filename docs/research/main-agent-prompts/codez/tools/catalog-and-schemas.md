# 当前工具目录与完整输入 Schema

## 曝光与行为表

| 工具 | Exposure | 并发 | 中断 | 超时 | 最大模型结果 |
|---|---|---|---|---:|---:|
| Bash | Always | Exclusive | Cancel | 126s | 100k chars |
| Edit | Always | ResourceLocked | Block | 无 | 100k |
| Glob | Always | Safe | Cancel | 35s | 100k |
| Grep | Always | Safe | Cancel | 35s | 100k |
| PowerShell | Always, Windows | Exclusive | Cancel | 126s | 100k |
| Read | Always | Safe | Cancel | 30s | 100k |
| TodoCreate/TodoUpdate/TodoArchive | Always | ResourceLocked | Cancel | 30s | 64k |
| ToolSearch | Always | Safe | Cancel | 5s | 32k |
| Write | Always | ResourceLocked | Block | 无 | 100k |
| Agent spawn/followup/send/wait/interrupt | Always | ResourceLocked | Cancel | 30s；wait 305s | 512k |
| list_agents | Always | Safe | Cancel | 30s | 512k |
| list_files | Always | Safe | Cancel | 30s | 100k |
| Skill/ActivateSkill/DeactivateSkill | Core | ResourceLocked | Cancel | 30s | 1MiB |
| ToolResultRead | Core | Safe | Cancel | 30s | 55k |
| NotebookEdit | Deferred | ResourceLocked | Block | 无 | 100k |
| PushNotification | Deferred | ResourceLocked | Cancel | 10s | 8k |
| WebFetch/WebSearch | Deferred | Safe | Cancel | 30s | 128k |
| AskUserQuestion | 主 run 单独追加 | 宿主交互 | 等待用户 | 宿主控制 | 宿主控制 |

## 文件与搜索工具

### Read

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "files": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "file_path": { "type": "string", "minLength": 1 },
          "offset": { "type": "integer", "minimum": 1 },
          "limit": { "type": "integer", "minimum": 1, "maximum": 5000 }
        },
        "required": ["file_path"]
      }
    }
  },
  "required": ["files"]
}
```

### Edit

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "file_path": { "type": "string", "minLength": 1 },
    "edits": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "old_string": { "type": "string", "minLength": 1 },
          "new_string": { "type": "string" },
          "replace_all": { "type": "boolean" }
        },
        "required": ["old_string", "new_string"]
      }
    }
  },
  "required": ["file_path", "edits"]
}
```

### Write

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "file_path": { "type": "string", "minLength": 1 },
    "content": { "type": "string" }
  },
  "required": ["file_path", "content"]
}
```

### NotebookEdit

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "notebook_path": { "type": "string", "minLength": 1 },
    "cell_id": { "type": "string", "minLength": 1 },
    "cell_index": { "type": "integer", "minimum": 0 },
    "cell_type": { "type": "string", "enum": ["code", "markdown", "raw"] },
    "new_source": { "type": "string" },
    "edit_mode": { "type": "string", "enum": ["replace", "insert", "delete"] }
  },
  "required": ["notebook_path"]
}
```

### Glob

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "pattern": { "type": "string", "minLength": 1, "maxLength": 16384, "description": "Glob pattern, e.g. **/*.ts." },
    "path": { "type": "string", "minLength": 1, "maxLength": 4096, "description": "Optional workspace subdirectory." },
    "head_limit": { "type": "integer", "minimum": 1, "maximum": 5000, "default": 1000 }
  },
  "required": ["pattern"]
}
```

### Grep

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "pattern": { "type": "string", "minLength": 1, "maxLength": 16384 },
    "path": { "type": "string", "minLength": 1, "maxLength": 4096 },
    "output_mode": { "type": "string", "enum": ["files_with_matches", "content", "count"], "default": "files_with_matches" },
    "glob": { "type": "string", "minLength": 1, "maxLength": 4096 },
    "type": { "type": "string", "minLength": 1, "maxLength": 4096 },
    "-A": { "type": "integer", "minimum": 0, "maximum": 1000 },
    "-B": { "type": "integer", "minimum": 0, "maximum": 1000 },
    "-C": { "type": "integer", "minimum": 0, "maximum": 1000 },
    "-n": { "type": "boolean" },
    "-i": { "type": "boolean" },
    "-o": { "type": "boolean" },
    "multiline": { "type": "boolean" },
    "head_limit": { "type": "integer", "minimum": 1, "maximum": 5000, "default": 1000 },
    "offset": { "type": "integer", "minimum": 0, "maximum": 100000, "default": 0 }
  },
  "required": ["pattern"]
}
```

### list_files

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "dirPaths": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "uniqueItems": true,
      "items": { "type": "string", "minLength": 1, "maxLength": 4096 }
    },
    "dirPath": { "type": "string", "minLength": 1, "maxLength": 4096 }
  }
}
```

## Shell

`Bash` 与 `PowerShell` schema 相同：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "command": { "type": "string", "minLength": 1 },
    "timeout": { "type": "integer", "minimum": 250, "maximum": 120000 },
    "task_id": { "type": "string", "minLength": 1 },
    "action": { "type": "string", "enum": ["wait", "interrupt"] },
    "run_in_background": { "type": "boolean" }
  }
}
```

Schema 用组合约束之外的执行解析保证两种合法模式：提交 `command`，或者提交 `task_id + action`。

## ToolSearch 与大结果

### ToolSearch

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "query": { "type": "string", "minLength": 1, "description": "Tool name or capability query. Use select:<tool_name> for direct selection." },
    "max_results": { "type": "integer", "minimum": 1, "maximum": 20, "default": 5 }
  },
  "required": ["query"]
}
```

### ToolResultRead

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "handle": { "type": "string", "pattern": "^tool-result://[A-Za-z0-9_-]+$" },
    "offset": { "type": "integer", "minimum": 0, "default": 0 },
    "limit": { "type": "integer", "minimum": 1, "maximum": 50000, "default": 20000 }
  },
  "required": ["handle"]
}
```

## Skill 工具

### Skill

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "skill": { "type": "string", "minLength": 1, "maxLength": 256, "description": "Exact available skill name or ID." },
    "args": { "type": "string", "maxLength": 8192, "description": "Optional arguments for this activation." }
  },
  "required": ["skill"]
}
```

### ActivateSkill

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "skill": { "type": "string", "minLength": 1, "maxLength": 256, "description": "Exact available skill name or ID." },
    "args": { "type": "string", "maxLength": 8192, "description": "Optional arguments for this activation." },
    "force": { "type": "boolean", "description": "Refresh content or re-enable a session-disabled skill after an explicit user request." }
  },
  "required": ["skill"]
}
```

### DeactivateSkill

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "skill": { "type": "string", "minLength": 1, "maxLength": 256 },
    "mode": { "type": "string", "enum": ["inactive", "disabled"] },
    "reason": { "type": "string", "maxLength": 1024 }
  },
  "required": ["skill"]
}
```

## Task 工具

共享 task fields：

```json
{
  "subject": { "type": "string", "minLength": 1, "maxLength": 512 },
  "description": { "type": "string", "maxLength": 32768 },
  "status": { "type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"] },
  "files": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
  "activeForm": { "type": "string", "minLength": 1, "maxLength": 1024 },
  "groupId": { "type": "string", "minLength": 1, "maxLength": 1024 },
  "groupTitle": { "type": "string", "minLength": 1, "maxLength": 1024 },
  "groupSubtitle": { "type": "string", "minLength": 1, "maxLength": 1024 },
  "riskLevel": { "type": "string", "enum": ["low", "medium", "high"] },
  "requiresApproval": { "type": "boolean" },
  "approvalStatus": { "type": "string", "enum": ["not_required", "pending", "approved", "changes_requested", "rejected"] },
  "acceptanceCriteria": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
  "verificationCommand": { "type": "string", "minLength": 1, "maxLength": 8192 },
  "contextBundle": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "knownFacts": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
      "decisions": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
      "constraints": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
      "excludedDirections": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
      "sourceReferences": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } }
    }
  }
}
```

`TodoCreate`：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "items": {
      "type": "array",
      "minItems": 1,
      "maxItems": 256,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "subject": { "type": "string", "minLength": 1, "maxLength": 512 },
          "description": { "type": "string", "maxLength": 32768 },
          "files": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
          "activeForm": { "type": "string", "minLength": 1, "maxLength": 1024 },
          "groupId": { "type": "string", "minLength": 1, "maxLength": 1024 },
          "groupTitle": { "type": "string", "minLength": 1, "maxLength": 1024 },
          "groupSubtitle": { "type": "string", "minLength": 1, "maxLength": 1024 },
          "riskLevel": { "type": "string", "enum": ["low", "medium", "high"] },
          "requiresApproval": { "type": "boolean" },
          "approvalStatus": { "type": "string", "enum": ["not_required", "pending", "approved", "changes_requested", "rejected"] },
          "acceptanceCriteria": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
          "verificationCommand": { "type": "string", "minLength": 1, "maxLength": 8192 },
          "contextBundle": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "knownFacts": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
              "decisions": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
              "constraints": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
              "excludedDirections": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
              "sourceReferences": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } }
            }
          }
        },
        "required": ["subject"]
      }
    }
  },
  "required": ["items"]
}
```

`TodoUpdate` 在顶层接受 revision 和 batch：

```json
{
  "expectedRevision": { "type": "integer", "minimum": 0 },
  "updates": {
    "type": "array",
    "minItems": 1,
    "items": {
      "todoId": { "type": "string", "pattern": "^t[1-9][0-9]*$" },
      "status": { "type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"] }
    }
  }
}
```

顶层 `required` 只有 `updates`。同一 batch 重复 todoId 会整体失败。TodoGet/TodoList 只存在于内部 IPC，不是模型工具。

## Agent 工具

`spawn_agent` 的完整 schema：

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
      "type": "object", "additionalProperties": false,
      "properties": {
        "questions": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
        "outOfScope": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } }
      }
    },
    "scope": {
      "type": "object", "additionalProperties": false,
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

`followup_task`、`send_message`：

```json
{
  "type": "object", "additionalProperties": false,
  "required": ["target", "message"],
  "properties": {
    "target": { "type": "string", "minLength": 1, "maxLength": 512 },
    "message": { "type": "string", "minLength": 1, "maxLength": 131072 }
  }
}
```

`interrupt_agent` 只要求相同的 `target`。`list_agents` 为空 object。`wait_agent`：

```json
{
  "type": "object", "additionalProperties": false,
  "properties": {
    "targets": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 512 } },
    "timeoutMs": { "type": "integer", "minimum": 0, "maximum": 300000 }
  }
}
```

## Web 与通知

### WebSearch

```json
{
  "type": "object", "additionalProperties": false,
  "properties": {
    "query": { "type": "string", "minLength": 1, "maxLength": 1024 },
    "allowed_domains": { "type": "array", "maxItems": 20, "items": { "type": "string", "minLength": 1, "maxLength": 253 } },
    "blocked_domains": { "type": "array", "maxItems": 20, "items": { "type": "string", "minLength": 1, "maxLength": 253 } }
  },
  "required": ["query"]
}
```

### WebFetch

```json
{
  "type": "object", "additionalProperties": false,
  "properties": {
    "url": { "type": "string", "minLength": 1, "maxLength": 8192 },
    "prompt": { "type": "string", "maxLength": 4096 }
  },
  "required": ["url"]
}
```

### PushNotification

```json
{
  "type": "object", "additionalProperties": false,
  "properties": {
    "message": { "type": "string", "minLength": 1, "maxLength": 200, "description": "One-line notification body without Markdown." },
    "status": { "type": "string", "enum": ["info", "success", "warning", "error"], "default": "info" }
  },
  "required": ["message"]
}
```

## AskUserQuestion

```json
{
  "type": "object", "additionalProperties": false,
  "properties": {
    "questions": {
      "type": "array", "minItems": 1, "maxItems": 4,
      "items": {
        "type": "object", "additionalProperties": false,
        "properties": {
          "question": { "type": "string" },
          "header": { "type": "string" },
          "options": {
            "type": "array", "minItems": 2, "maxItems": 4,
            "items": {
              "type": "object", "additionalProperties": false,
              "properties": {
                "label": { "type": "string" },
                "description": { "type": "string" },
                "detail": { "type": "string" }
              },
              "required": ["label"]
            }
          },
          "multiSelect": { "type": "boolean" },
          "ignoreLabel": { "type": "string" },
          "submitLabel": { "type": "string" }
        },
        "required": ["question", "header", "options"]
      }
    }
  },
  "required": ["questions"]
}
```
