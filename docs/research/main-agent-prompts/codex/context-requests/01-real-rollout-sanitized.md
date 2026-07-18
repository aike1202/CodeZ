# Codex 真实 rollout 首轮上下文

## Provenance

```yaml
classification: real-rollout-sanitized
session_id: 019f69f8-1394-71b3-a0e3-2821d2e79fcf
cli_version: 0.144.2
originator: Codex Desktop
source: vscode
model: gpt-5.6-sol
reasoning_effort: xhigh
timestamp: 2026-07-16T08:08:42.600Z
raw_rollout: C:\Users\asus\.codex\sessions\2026\07\16\rollout-2026-07-16T16-08-21-019f69f8-1394-71b3-a0e3-2821d2e79fcf.jsonl
```

## 记录顺序

| JSONL line | rollout record | 内容 |
|---:|---|---|
| 1 | `session_meta` | 16,299 字符 base instructions、客户端、版本、cwd、provider |
| 2 | `event_msg/task_started` | task 开始 |
| 3 | `response_item/developer` | permissions、app context、collaboration mode、skills、plugins |
| 4 | `response_item/developer` | `/root` multi-agent coordinator contract、4-slot runtime snapshot |
| 5 | `response_item/developer` | explicit-request-only delegation policy |
| 6 | `response_item/user` | environment context |
| 7 | `world_state` | skills/plugins/environment runtime state |
| 8 | `turn_context` | model、effort、approval、sandbox、context window、git |
| 9 | `response_item/user` | `了解这个项目` |
| 13 | `custom_tool_call` | 首个 shell/tool 调用 |

## 归一化完整请求

```json
{
  "request_kind": "codex_runtime_logical_request",
  "model": "gpt-5.6-sol",
  "reasoning": "xhigh",
  "base_instructions": {
    "content_ref": "../main-agent-prompt.md",
    "source": "session_meta.payload.base_instructions.text",
    "characters": 16299,
    "lines": 146
  },
  "developer_layers": [
    {
      "name": "permissions",
      "content": {
        "sandbox_mode": "danger-full-access",
        "network_access": true,
        "approval_policy": "never",
        "sandbox_permissions_argument_forbidden": true
      }
    },
    {
      "name": "app_context",
      "features": [
        "local image rendering",
        "workspace dependency helper",
        "automations",
        "thread coordination",
        "inline code comments",
        "git UI directives"
      ]
    },
    {
      "name": "collaboration_mode",
      "mode": "default",
      "instruction": "Prefer reasonable assumptions and execution; ask only when a material choice cannot be discovered safely."
    },
    {
      "name": "skills",
      "catalog_status": "present_in_full_in_rollout_line_3",
      "selected_relevant_skill": "none for the original project-understanding task"
    },
    {
      "name": "plugins",
      "catalog_status": "present_in_rollout_line_3"
    },
    {
      "name": "multi_agent_coordinator",
      "root_name": "/root",
      "runtime_slots_snapshot": 4,
      "shared_filesystem": true
    },
    {
      "name": "multi_agent_policy",
      "value": "Do not spawn sub-agents unless directly requested or required by AGENTS.md/skill instructions."
    }
  ],
  "environment": {
    "cwd": "[REDACTED_WORKSPACE]",
    "shell": "powershell",
    "current_date": "2026-07-16",
    "timezone": "Asia/Shanghai",
    "filesystem": "unrestricted",
    "git_branch": "master"
  },
  "input": [
    {
      "role": "user",
      "content": "了解这个项目"
    }
  ],
  "tools": {
    "catalog_source": "runtime",
    "schema_persistence_note": "The rollout records calls and selected app tool schemas, but this sample does not claim a byte-complete outbound HTTP tools array."
  }
}
```

## 首次行为

主 Agent 先发送 commentary：

```text
我先梳理项目目录、入口、依赖和现有文档，再沿核心调用链读几处关键代码；这一轮只做理解和总结，不改文件。
```

随后直接使用本地工具，没有派发子 Agent。这个行为与该次 developer policy 一致：用户没有要求委派，任务也没有适用规则强制委派。

## 完整性说明

base instructions 可逐字恢复；developer/user 层也在 rollout 中逐字存在。工具 registry 的最终 wire encoding 未作为一个独立 outbound request body 保存，因此本文件是“完整逻辑上下文”，不是 HTTP byte dump。

