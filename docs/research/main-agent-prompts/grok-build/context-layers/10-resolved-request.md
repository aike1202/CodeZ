# 10 Grok Build 完整逻辑请求

以下是 source-derived envelope，不是抓包：

```json
{
  "classification": "simulated-source-derived",
  "source_revision": "8adf9013a0929e5c7f1d4e849492d2387837a28d",
  "system": {
    "ref": "../main-agent-prompt.md",
    "template": "templates/prompt.md",
    "audience": "primary",
    "prompt_mode": "extend",
    "rendered_by": "ToolBridge + MiniJinja"
  },
  "developer": {
    "separate_role": false,
    "equivalent_layers": ["PromptContext", "role/persona", "user reminders", "tool capability/config"]
  },
  "tools": {
    "ref": "../tools/README.md",
    "source": "finalized ToolRegistry",
    "names": ["Read", "Edit", "Glob", "Grep", "Bash", "UpdatePlan", "Monitor"]
  },
  "project_rules": ["AGENTS.md/Claude.md scoped system-reminder"],
  "environment": {
    "prefix": "<user_info> + optional <git_status>",
    "os": "windows",
    "shell": "powershell.exe",
    "cwd": "F:\\workspace\\sample",
    "date": "2026-07-18"
  },
  "catalogs": ["skills", "built-in/custom agents", "plugins", "MCP"],
  "history": [],
  "reminders": [],
  "current_request": {
    "wrapper": "<user_query>",
    "text": "分析登录失败的根因，只做调查，不修改文件。"
  }
}
```

展开后的首条 message 和 tools 占位见 [01-source-derived-request.md](../context-requests/01-source-derived-request.md)。
