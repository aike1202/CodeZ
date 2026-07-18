# 03 工具描述与 JSON Schema

## 进入 Provider 的内容

每个工具按 OpenAI-compatible function schema 发送：

```json
{
  "type": "function",
  "function": {
    "name": "Read",
    "description": "Reads bounded text files after path authorization.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {},
      "required": []
    }
  }
}
```

真正的 `parameters` 由各 `ToolDescriptor.input_schema()` 提供。全量 schema 直接写在 `tools/catalog-and-schemas.md`，各工具核心算法写在同目录的分组文件中。

## 首轮目录

主 Agent 首轮 Provider tools 共 24 个：23 个 eager catalog tools，加上单独追加的 `AskUserQuestion`。

```text
Bash, Edit, Glob, Grep, PowerShell, Read,
TaskCreate, TaskGet, TaskList, TaskUpdate, ToolSearch, Write,
followup_task, interrupt_agent, list_agents, list_files,
send_message, spawn_agent, wait_agent,
ActivateSkill, DeactivateSkill, Skill, ToolResultRead,
AskUserQuestion
```

Deferred：

```text
NotebookEdit, PushNotification, WebFetch, WebSearch
```

当前 PromptContext 错误地把 deferred list 设为空，所以 System Prompt 只显示首轮 24 个工具，实际 exposure plan 仍知道这 4 个工具，`ToolSearch` 也能激活它们供下一轮使用。

## Agent 工具面

Explore：

```text
Read, Glob, Grep, list_files, ToolResultRead,
send_message, list_agents, wait_agent
```

Reviewer 在此基础上增加：

```text
Bash, PowerShell
```

子 Agent 不会收到 `AskUserQuestion`，也不会收到 `spawn_agent`、写工具、Task 或 Skill 工具。
