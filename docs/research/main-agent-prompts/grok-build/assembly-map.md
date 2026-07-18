# Grok Build 主提示词装配图

## System prompt

`PromptContext::render()` 根据 `prompt_mode`、`audience` 和 `system_prompt` 选择模板：

```text
PromptMode::Extend
  TemplateOverride::Custom -> custom template
  TemplateOverride::Codex  -> apply_patch_prompt.md
  TemplateOverride::None
    Primary                -> prompt.md
    Subagent               -> subagent_prompt.md
  + optional prompt_body

PromptMode::Full
  prompt_body only
```

基座和 `prompt_body` 都经过 `ToolBridge::render_prompt()`，最终由 `TemplateRenderer` 使用 MiniJinja 渲染。

## 模板占位符

`PromptContext::placeholders()` 提供：

```text
memory_enabled
memory_global_path
memory_workspace_path
role_instructions
persona_instructions
os_name
shell_path
working_directory
current_date
is_non_interactive
system_prompt_label
```

工具名称由最终 ToolRegistry 提供：

```text
tools.by_kind.read
tools.by_kind.edit
tools.by_kind.list
tools.by_kind.search
tools.by_kind.execute
tools.by_kind.web_search
tools.by_kind.plan
tools.by_kind.monitor
...
```

模板通过 `${%- if tools.by_kind.X %}` 隐藏当前 Agent 无法使用的整段规则，因此 prompt 与工具权限天然一致。

## 第一条 user message

默认 shell 路径生成：

```text
<user_info>
OS Version: {{ os }}
Shell: {{ shell }}
Workspace Path: {{ cwd }}
Today's date: {{ local_date }}
Note: Prefer using relative paths over absolute paths as tool call args when possible.
</user_info>

<git_status> ... optional snapshot ... </git_status>

<user_query>
{{ user query }}
</user_query>
```

custom user-message template 还可加入 workspace/user rules、skill listing、MCP server descriptors 和 terminals folder。它同样经 ToolBridge/MiniJinja 渲染。

## 工具 schema

`ToolBridge::tool_definitions()` 从 finalized ToolRegistry 取得实际工具定义。主 system prompt 不枚举全部 schema，只引用按 kind 解析出的显示名称。API 请求仍会单独携带工具定义。

## Subagents

`task` 工具动态描述 built-in Agent：

```text
general-purpose -> all tools -> GENERAL_PURPOSE_PROMPT
explore         -> read-only -> EXPLORE_PROMPT
plan            -> read-only -> PLAN_PROMPT
```

子 Agent system 为 `subagent_prompt.md + prompt_body`。可选 role prompt 通过 `role_instructions` 渲染进共享模板。父 Agent 的 `AGENTS.md` 项目规则也会以 user reminder 传给子 Agent；persona 目录不会传给子 Agent，但解析出的 persona instructions 可作为独立 `<system-reminder>` 会话项注入。

## 关键设计

Grok 的优势是“能力驱动提示词”：规则不是根据产品名硬编码，而是根据实际 ToolKind 存在与否渲染。CodeZ 可以直接借鉴这种设计，避免只移除 Edit 工具却仍在 prompt 中要求 Agent 修改文件的矛盾。
