# Grok Build 源码驱动请求样例

## Provenance

```yaml
classification: simulated-source-derived
source_revision: 8adf9013a0929e5c7f1d4e849492d2387837a28d
audience: primary
prompt_mode: extend
system_prompt_override: none
is_non_interactive: false
system_prompt_label: Grok
platform: windows
```

## 渲染输入

```json
{
  "tools": {
    "by_kind": {
      "read": "Read",
      "edit": "Edit",
      "list": "Glob",
      "search": "Grep",
      "execute": "Bash",
      "plan": "UpdatePlan",
      "monitor": "Monitor"
    }
  },
  "is_non_interactive": false,
  "system_prompt_label": "Grok",
  "workspace_path": "F:\\workspace\\sample",
  "os": "windows",
  "shell": "powershell.exe",
  "today": "2026-07-18",
  "git_status": "## main\n M src/app.rs"
}
```

## 归一化完整逻辑请求

```json
{
  "request_kind": "source_derived_chat_request",
  "system": {
    "content_ref": "../main-agent-prompt.md",
    "rendered_variants": {
      "identity": "You are Grok released by xAI. You are an interactive CLI tool that helps users with software engineering tasks.",
      "read_tool": "Read",
      "edit_tool": "Edit",
      "monitor_section_present": true,
      "user_guide_present": true
    }
  },
  "messages": [
    {
      "role": "user",
      "content": "<user_info>\nOS Version: windows\nShell: powershell.exe\nWorkspace Path: F:\\workspace\\sample\nToday's date: 2026-07-18\nNote: Prefer using relative paths over absolute paths as tool call args when possible.\n</user_info>\n\n<git_status>\nThis is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.\n## main\n M src/app.rs\n</git_status>\n\n<user_query>\n分析登录失败的根因，只做调查，不修改文件。\n</user_query>"
    }
  ],
  "tools": [
    { "name": "Read", "kind": "read", "schema": "[REGISTRY_SCHEMA]" },
    { "name": "Edit", "kind": "edit", "schema": "[REGISTRY_SCHEMA]" },
    { "name": "Glob", "kind": "list", "schema": "[REGISTRY_SCHEMA]" },
    { "name": "Grep", "kind": "search", "schema": "[REGISTRY_SCHEMA]" },
    { "name": "Bash", "kind": "execute", "schema": "[REGISTRY_SCHEMA]" },
    { "name": "UpdatePlan", "kind": "plan", "schema": "[REGISTRY_SCHEMA]" },
    { "name": "Monitor", "kind": "monitor", "schema": "[REGISTRY_SCHEMA]" }
  ]
}
```

## 说明

- system 全文就是 `../main-agent-prompt.md` 在上述变量下的确定性渲染，未重复复制以避免模板更新后两处漂移。
- `tools` schema 由 finalized ToolRegistry 产生，具体字段取决于宿主启用的工具实现；占位符不是声称省略了已抓取内容。
- 默认第一条 user message 将环境和 git 状态与 `<user_query>` 放在同一 user role 中，而不是塞进 system prompt。

