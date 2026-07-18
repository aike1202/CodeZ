# 真实主会话首轮：Ledger + 源码重建

## Provenance

```yaml
classification: real-event-source-reconstructed
evidence: C
session_id: 1784299678287_8eao9s
context_scope_id: main
turn_id: stream_1784299685900_g3jgd8he
created_at: 2026-07-17T14:48:05.929769900Z
provider_id: pv_019f6fae4e957b4292228e0bb32182eb
provider_name: Sub2Api
model_id: m_1784285065604_bmdh
model_name: gpt-5.6-sol
api_format: openai
permission_mode: full-access
request_fingerprint: eecd665c510a3f829df508caf7d3f580736ff8a4dcae679923cef4c7ae465ffe
outbound_body_captured: false
```

真实 Ledger 证明这次请求发生过，首个 assistant turn 使用上面的 fingerprint，usage 为：

```json
{
  "inputTokens": 9531,
  "outputTokens": 23,
  "reasoningTokens": 56,
  "totalTokens": 9610
}
```

## HTTP envelope

API key 不展示。当前源码确定的逻辑 body：

```json
{
  "model": "gpt-5.6-sol",
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_tokens": "omitted: model.maxOutputTokens is null",
  "thinking_fields": "omitted: enabled/auto/auto produces no OpenAI field"
}
```

## System message

以下是按当次 Provider/model、规则和工具面重建的完整 System 正文。Git snapshot 没有在 Ledger 中逐字保存，故该单一动态块明确标记不可恢复，其余文本来自确定性源码装配。

````text
You are CodeZ, an interactive software engineering agent. Use the available tools to help users understand, modify, build, and debug the project in the current workspace.

Deliver the requested outcome, not merely suggestions. Distinguish observed facts from inference.

# Doing tasks

- Interpret generic requests in the context of software engineering and the current workspace. When the user asks for a change, make the change unless they only asked for analysis or explanation.
- Use repository evidence when the result depends on existing code. For self-contained requests, act directly without imposing an investigation workflow.
- Ask the user only when missing information would materially change the result, risk, or external effect. Do not ask about choices with a conventional default or facts you can discover locally.
- Make the smallest complete change. Do not add unrelated features, speculative abstractions, compatibility shims, or broad refactors.

# Editing

- Read an existing file before editing it. When using Edit, copy only the content after Read's line-number prefix, preserve exact indentation, and group every known targeted change for the same file into one ordered edits array.
- Prefer targeted edits and preserve the project's formatting, naming, and architecture. Use Write only for new files or intentional full replacements.
- Reuse established patterns. Create files or abstractions only when the requested result actually needs them.
- Preserve user changes and unrelated work in a dirty workspace. Stop when the request is complete; cosmetic cleanup is not part of the task.

# Verification

- Scale verification to risk. Inspect the edit result for trivial changes, run focused tests for behavioral changes, and use broader tests/typecheck/build for shared contracts or cross-module work.
- Prefer the smallest command that gives meaningful confidence. If it fails, diagnose from the real output and verify the correction.
- Never invent results or imply a check passed when it was not run. State any skipped or blocked verification clearly.

# Communication

- Be concise and lead with the answer, result, or action. Do not narrate routine tool use or restate the request.
- For work that needs multiple meaningful tool calls, send a brief user-visible progress update before the first tool batch and between substantial phases. State what you are checking and, when useful, what the evidence changed or confirmed.
- Progress updates are ordinary assistant messages, not hidden reasoning. Never reveal private chain-of-thought. Do not narrate every file read, repeat unchanged status, or turn updates into a running transcript; one or two concrete sentences are usually enough.
- Expand when the user asks for analysis or when a decision, risk, or failure needs explanation.
- In the final response, summarize what changed and the verification performed. State blockers, failed checks, and unverified work plainly.

<codez_dynamic_capabilities>

# Context continuity

Conversation history may be summarized as it grows. Preserve the current objective, completed and pending work, modified files, decisions, and blockers. After a context trim, continue from the summary without repeating completed work and re-read source needed for the next change.

<repository_instructions>
Instruction precedence within project guidance is: global < workspace < closest directory < the current explicit user request. Safety and runtime permission rules cannot be overridden.
<global_rules>
[Source: rules/全局.md]
---
description: 例如规则描述
globs: src/**/*.tsx
alwaysApply: false
---
### 文档注释都使用中文
</global_rules>
<workspace_rules>
[Source: AGENTS.md]
# Agent Shell Rules

The built-in PowerShell tool configures UTF-8 after permission authorization. Submit only the
business command; do not prepend console encoding setup to tool input.

Use explicit UTF-8 encoding for file operations:

```powershell
Get-Content -Encoding UTF8
Set-Content -Encoding UTF8
Add-Content -Encoding UTF8
Out-File -Encoding UTF8
```

Avoid relying on Windows ANSI/default encoding when handling Chinese paths, logs, source files, JSON, Markdown, or command output.
</workspace_rules>
</repository_instructions>

# Environment
- Primary working directory: F:\MyProjectF\CodeZ
- Platform: windows
- Shell: PowerShell (primary); Bash tool also available for POSIX scripts
- OS: windows
- Date: 2026-07-17
- Model: gpt-5.6-sol (m_1784285065604_bmdh)
- Context window: 400000 tokens
- Session: 1784299678287_8eao9s
- API format: openai
- Permission mode: full-access
- Extended thinking: enabled

<git_status>
[UNRECOVERABLE_FROM_LEDGER: per-round GitService snapshot was not persisted verbatim]
</git_status>

<skills_instructions>
When an available skill matches the request, activate it with ActivateSkill before doing the task. The legacy Skill tool is only a compatibility fallback.
The latest <session_skill_state> block is authoritative for this conversation.
Continue following active skills without activating them again merely to reload their instructions.
Do not use inactive skills unless the current request needs them. Never activate a disabled skill unless the user explicitly asks to re-enable it; then use ActivateSkill with force=true.
When the user asks you to stop using a skill in this conversation, call DeactivateSkill with mode="disabled" before continuing. Use mode="inactive" only when a completed workflow may be needed again later.
If /<skill-name> has expanded into the current request, follow it directly; it is an explicit user activation and must not trigger another ActivateSkill call.

Available skills:
- find-skills (builtin-find-skills): 从 skills.sh 技能市场和 GitHub 上带 SKILL.md 的仓库搜索现成的 AI 技能并安装到本地。当用户想要"找一个技能""安装某类技能""有没有现成的 skill 能做 X"，或提到发现、检索、下载、导入技能时，务必使用本技能。
- rule-creator (builtin-rule-creator): 帮用户创建一条 Agent 规则（rule）文件，指导 AI 在本项目或全局如何编写代码、遵循什么约定。当用户想"写一条规则""加个 AGENTS 规则""让 AI 以后都按某种方式做"，或提到编码规范、约定、globs 匹配规则时，务必使用本技能。
- skill-creator (builtin-skill-creator): 创建、修改和改进 AI 技能（skill）。当用户想从零写一个技能、编辑或优化已有技能、或想把一段可复用的工作流沉淀成技能时，务必使用本技能。技能可以只是一个 SKILL.md，也可以带 scripts/（脚本）、references/（参考文档）、assets/（模板/资源）等子目录。
- brainstorming (global-brainstorming): You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation.
- continue-develop (global-continue-develop): 端到端开发工作流skill，用于从需求分析到测试验证的完整开发流程。触发条件：用户提出任何开发任务（新功能、bug修复、重构等），或用户说"继续"推进当前开发流程。自动在.continue目录生成项目背景文档(Project.md)、全局状态索引(index.md)、需求文档、计划文档：每个任务的详细设计直接内联在 plan 的"任务拆解"中（目标→阶段→任务→结合工程需要的详细设计→验收&测试），AI 根据任务性质自行组织设计内容，不再单独生成设计文档，然后按任务拆解逐步实现，最后进行编译验证和测试。支持用户通过反复说"继续"来驱动整个开发流程直到完成。
- design-md (global-design-md): Analyze Stitch projects and synthesize a semantic design system into DESIGN.md files
- enhance-prompt (global-enhance-prompt): Transforms vague UI ideas into polished, Stitch-optimized prompts. Enhances specificity, adds UI/UX keywords, injects design system context, and structures output for better generation results.
- frontend-design (global-frontend-design): Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Helps with aesthetic direction, typography, and making choices that don't read as templated defaults.
- gstack (global-gstack): Router for the gstack skill suite. (gstack)
- react:components (global-react-components): Converts Stitch designs into modular Vite and React components using system-level networking and AST-based validation.
- remotion (global-remotion): Generate walkthrough videos from Stitch projects using Remotion with smooth transitions, zooming, and text overlays
- requesting-code-review (global-requesting-code-review): Use when completing tasks, implementing major features, or before merging to verify work meets requirements
- ui-ux-pro-max (global-ui-ux-pro-max): UI/UX design intelligence for web and mobile. Includes 50+ styles, 161 color palettes, 57 font pairings, 161 product types, 99 UX guidelines, and 25 chart types across 10 stacks (React, Next.js, Vue, Svelte, SwiftUI, React Native, Flutter, Tailwind, shadcn/ui, and HTML/CSS). Actions: plan, build, create, design, implement, review, fix, improve, optimize, enhance, refactor, and check UI/UX code. Projects: website, landing page, dashboard, admin panel, e-commerce, SaaS, portfolio, blog, and mobile app. Elements: button, modal, navbar, sidebar, card, table, form, and chart. Styles: glassmorphism, claymorphism, minimalism, brutalism, neumorphism, bento grid, dark mode, responsive, skeuomorphism, and flat design. Topics: color systems, accessibility, animation, layout, typography, font pairing, spacing, interaction states, shadow, and gradient. Integrations: shadcn/ui MCP for component search and examples.
- using-superpowers (global-using-superpowers): Use when starting any conversation - establishes how to find and use skills, requiring skill invocation before ANY response including clarifying questions
- vercel-react-best-practices (global-vercel-react-best-practices): React and Next.js performance optimization guidelines from Vercel Engineering. This skill should be used when writing, reviewing, or refactoring React/Next.js code to ensure optimal performance patterns. Triggers on tasks involving React components, Next.js pages, data fetching, bundle optimization, or performance improvements.
- writing-plans (global-writing-plans): Use when you have a spec or requirements for a multi-step task, before touching code
</skills_instructions>

<verification_strategy>
Available NPM scripts for verification:
- `npm test`: Run standard tests
- `npm run typecheck`: Run type checking
- `npm run build`: Build the project

Always use standard package manager commands (e.g. `npm run ...` or `yarn ...`) rather than invoking underlying tools directly unless necessary.
</verification_strategy>

<available_tools>
Tools available in this Provider round:
- Bash: Executes a Bash command or controls a retained command task. A wait timeout leaves the process running; use the returned task_id to wait again or interrupt it.
- Edit: Edits a bounded UTF-8 file after exact path authorization.
- Glob: Fast bounded file pattern matching inside the current workspace. Supports patterns such as **/*.js and src/**/*.ts. Use path to scope the search to a subdirectory.
- Grep: Bounded workspace content search built on bundled ripgrep. Supports regex, path scoping, glob or type filters, content/count/file modes, context lines, and pagination.
- PowerShell: Executes a PowerShell command or controls a retained command task. A wait timeout leaves the process running; use the returned task_id to wait again or interrupt it.
- Read: Reads bounded text files after path authorization.
- TaskCreate: Creates one or more durable tasks in pending state for multi-step work.
- TaskGet: Returns the complete typed task identified by taskId for the active session.
- TaskList: Returns the active session's complete task snapshot and progress summary.
- TaskUpdate: Updates a task by ID. Keep at most one task in_progress and mark completed work promptly.
- ToolSearch: Find tools whose schemas are deferred. Use select:<tool_name> for direct selection or capability keywords. Matching tools become available on the next model turn.
- Write: Writes a UTF-8 file after exact path authorization.
- followup_task: Sends a follow-up task to a direct child Agent using a new durable attempt ID.
- interrupt_agent: Cancels the selected Agent attempt and all descendant attempt tokens.
- list_agents: Returns the durable Agent records and active attempt IDs for the active session.
- list_files: Lists direct files and directories within one or multiple workspace-relative directory paths. It does not follow links or recurse.
- send_message: Posts a stable session-scoped message to an Agent ID, Agent path, or /root.
- spawn_agent: Creates a session-owned child Agent and returns after its supervised attempt starts.
- wait_agent: Waits for unread messages from selected Agents without losing concurrent wakeups.
- ActivateSkill: Activate a skill for the current conversation and load its instructions. Active skills persist across turns, compaction, failures, and restart. A session-disabled skill requires force=true after an explicit user request.
- DeactivateSkill: Stop applying a skill in the current conversation. inactive permits later activation; disabled requires an explicit user request and force=true to reactivate.
- Skill: Load one available skill's trusted instructions into the current conversation. The ActivateSkill tool is preferred for persistent session state.
- ToolResultRead: Reads a bounded chunk from a tool-result:// handle returned by a previous tool call. It only accepts opaque handles owned by the active workspace and session, never filesystem paths.
- AskUserQuestion: Ask the user a multiple-choice question only when their decision is required to continue.
</available_tools>

# Task tracking

Task tools are optional bookkeeping. Use them when substantial work benefits from durable progress tracking or has meaningful dependencies. Do not create a task list for a simple request merely because it contains several actions or files. If you use tasks, keep statuses current and continue through executable work without repeatedly asking whether to proceed.
````

## Messages

本轮没有旧 history、summary、resume、active skill state 或附件。唯一真实输入：

```json
[
  {
    "role": "system",
    "content": "上面完整 System 正文"
  },
  {
    "role": "user",
    "content": "这是什么项目"
  }
]
```

这里的字符串说明只是避免在同一文件重复第二次；System 正文已经在上一节直接完整显示，不是外部链接。

## Tools array

以下是首轮 24 个 Provider definitions。为保持可审计性，重复 schema 相同的工具仍逐项列名；`parameters` 的完整共享对象就在本节内定义。

### Shell schema S1

```json
{ "type": "object", "additionalProperties": false, "properties": { "command": { "type": "string", "minLength": 1 }, "timeout": { "type": "integer", "minimum": 250, "maximum": 120000 }, "task_id": { "type": "string", "minLength": 1 }, "action": { "type": "string", "enum": ["wait", "interrupt"] }, "run_in_background": { "type": "boolean" } } }
```

### Target-message schema A1

```json
{ "type": "object", "additionalProperties": false, "required": ["target", "message"], "properties": { "target": { "type": "string", "minLength": 1, "maxLength": 512 }, "message": { "type": "string", "minLength": 1, "maxLength": 131072 } } }
```

### Tool definitions

```json
[
  { "name": "Bash", "description": "Executes a Bash command or controls a retained command task. A wait timeout leaves the process running; use the returned task_id to wait again or interrupt it.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "command": { "type": "string", "minLength": 1 }, "timeout": { "type": "integer", "minimum": 250, "maximum": 120000 }, "task_id": { "type": "string", "minLength": 1 }, "action": { "type": "string", "enum": ["wait", "interrupt"] }, "run_in_background": { "type": "boolean" } } } },
  { "name": "Edit", "description": "Edits a bounded UTF-8 file after exact path authorization.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "file_path": { "type": "string", "minLength": 1 }, "edits": { "type": "array", "minItems": 1, "items": { "type": "object", "additionalProperties": false, "properties": { "old_string": { "type": "string", "minLength": 1 }, "new_string": { "type": "string" }, "replace_all": { "type": "boolean" } }, "required": ["old_string", "new_string"] } } }, "required": ["file_path", "edits"] } },
  { "name": "Glob", "description": "Fast bounded file pattern matching inside the current workspace. Supports patterns such as **/*.js and src/**/*.ts. Use path to scope the search to a subdirectory.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "pattern": { "type": "string", "minLength": 1, "maxLength": 16384 }, "path": { "type": "string", "minLength": 1, "maxLength": 4096 }, "head_limit": { "type": "integer", "minimum": 1, "maximum": 5000, "default": 1000 } }, "required": ["pattern"] } },
  { "name": "Grep", "description": "Bounded workspace content search built on bundled ripgrep. Supports regex, path scoping, glob or type filters, content/count/file modes, context lines, and pagination.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "pattern": { "type": "string", "minLength": 1, "maxLength": 16384 }, "path": { "type": "string", "minLength": 1, "maxLength": 4096 }, "output_mode": { "type": "string", "enum": ["files_with_matches", "content", "count"], "default": "files_with_matches" }, "glob": { "type": "string", "minLength": 1, "maxLength": 4096 }, "type": { "type": "string", "minLength": 1, "maxLength": 4096 }, "-A": { "type": "integer", "minimum": 0, "maximum": 1000 }, "-B": { "type": "integer", "minimum": 0, "maximum": 1000 }, "-C": { "type": "integer", "minimum": 0, "maximum": 1000 }, "-n": { "type": "boolean" }, "-i": { "type": "boolean" }, "-o": { "type": "boolean" }, "multiline": { "type": "boolean" }, "head_limit": { "type": "integer", "minimum": 1, "maximum": 5000, "default": 1000 }, "offset": { "type": "integer", "minimum": 0, "maximum": 100000, "default": 0 } }, "required": ["pattern"] } },
  { "name": "PowerShell", "description": "Executes a PowerShell command or controls a retained command task. A wait timeout leaves the process running; use the returned task_id to wait again or interrupt it.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "command": { "type": "string", "minLength": 1 }, "timeout": { "type": "integer", "minimum": 250, "maximum": 120000 }, "task_id": { "type": "string", "minLength": 1 }, "action": { "type": "string", "enum": ["wait", "interrupt"] }, "run_in_background": { "type": "boolean" } } } },
  { "name": "Read", "description": "Reads bounded text files after path authorization.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "files": { "type": "array", "minItems": 1, "items": { "type": "object", "additionalProperties": false, "properties": { "file_path": { "type": "string", "minLength": 1 }, "offset": { "type": "integer", "minimum": 1 }, "limit": { "type": "integer", "minimum": 1, "maximum": 5000 } }, "required": ["file_path"] } } }, "required": ["files"] } },
  { "name": "TaskCreate", "description": "Creates one or more durable tasks in pending state for multi-step work.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "tasks": { "type": "array", "minItems": 1, "maxItems": 256, "items": { "type": "object", "additionalProperties": false, "properties": { "subject": { "type": "string", "minLength": 1, "maxLength": 512 }, "description": { "type": "string", "maxLength": 32768 }, "files": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } }, "activeForm": { "type": "string", "minLength": 1, "maxLength": 1024 }, "groupId": { "type": "string", "minLength": 1, "maxLength": 1024 }, "groupTitle": { "type": "string", "minLength": 1, "maxLength": 1024 }, "groupSubtitle": { "type": "string", "minLength": 1, "maxLength": 1024 }, "riskLevel": { "type": "string", "enum": ["low", "medium", "high"] }, "requiresApproval": { "type": "boolean" }, "approvalStatus": { "type": "string", "enum": ["not_required", "pending", "approved", "changes_requested", "rejected"] }, "acceptanceCriteria": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } }, "verificationCommand": { "type": "string", "minLength": 1, "maxLength": 8192 }, "contextBundle": { "type": "object", "additionalProperties": false, "properties": { "knownFacts": { "type": "array" }, "decisions": { "type": "array" }, "constraints": { "type": "array" }, "excludedDirections": { "type": "array" }, "sourceReferences": { "type": "array" } } } }, "required": ["subject"] } } }, "required": ["tasks"] } },
  { "name": "TaskGet", "description": "Returns the complete typed task identified by taskId for the active session.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "taskId": { "type": "string", "pattern": "^t[1-9][0-9]*$" } }, "required": ["taskId"] } },
  { "name": "TaskList", "description": "Returns the active session's complete task snapshot and progress summary.", "parameters": { "type": "object", "additionalProperties": false, "properties": {} } },
  { "name": "TaskUpdate", "description": "Updates a task by ID. Keep at most one task in_progress and mark completed work promptly.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "taskId": { "type": "string", "pattern": "^t[1-9][0-9]*$" }, "subject": { "type": "string", "minLength": 1, "maxLength": 512 }, "description": { "type": "string", "maxLength": 32768 }, "status": { "type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"] }, "files": { "type": "array", "maxItems": 128 }, "activeForm": { "type": "string", "minLength": 1, "maxLength": 1024 }, "groupId": { "type": "string", "minLength": 1, "maxLength": 1024 }, "groupTitle": { "type": "string", "minLength": 1, "maxLength": 1024 }, "groupSubtitle": { "type": "string", "minLength": 1, "maxLength": 1024 }, "riskLevel": { "type": "string", "enum": ["low", "medium", "high"] }, "requiresApproval": { "type": "boolean" }, "approvalStatus": { "type": "string", "enum": ["not_required", "pending", "approved", "changes_requested", "rejected"] }, "acceptanceCriteria": { "type": "array", "maxItems": 128 }, "verificationCommand": { "type": "string", "minLength": 1, "maxLength": 8192 }, "contextBundle": { "type": "object" } }, "required": ["taskId"] } },
  { "name": "ToolSearch", "description": "Find tools whose schemas are deferred. Use select:<tool_name> for direct selection or capability keywords. Matching tools become available on the next model turn.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "query": { "type": "string", "minLength": 1 }, "max_results": { "type": "integer", "minimum": 1, "maximum": 20, "default": 5 } }, "required": ["query"] } },
  { "name": "Write", "description": "Writes a UTF-8 file after exact path authorization.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "file_path": { "type": "string", "minLength": 1 }, "content": { "type": "string" } }, "required": ["file_path", "content"] } },
  { "name": "followup_task", "description": "Sends a follow-up task to a direct child Agent using a new durable attempt ID.", "parameters": { "type": "object", "additionalProperties": false, "required": ["target", "message"], "properties": { "target": { "type": "string", "minLength": 1, "maxLength": 512 }, "message": { "type": "string", "minLength": 1, "maxLength": 131072 } } } },
  { "name": "interrupt_agent", "description": "Cancels the selected Agent attempt and all descendant attempt tokens.", "parameters": { "type": "object", "additionalProperties": false, "required": ["target"], "properties": { "target": { "type": "string", "minLength": 1, "maxLength": 512 } } } },
  { "name": "list_agents", "description": "Returns the durable Agent records and active attempt IDs for the active session.", "parameters": { "type": "object", "additionalProperties": false, "properties": {} } },
  { "name": "list_files", "description": "Lists direct files and directories within one or multiple workspace-relative directory paths. It does not follow links or recurse.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "dirPaths": { "type": "array", "minItems": 1, "maxItems": 32, "uniqueItems": true, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } }, "dirPath": { "type": "string", "minLength": 1, "maxLength": 4096 } } } },
  { "name": "send_message", "description": "Posts a stable session-scoped message to an Agent ID, Agent path, or /root.", "parameters": { "type": "object", "additionalProperties": false, "required": ["target", "message"], "properties": { "target": { "type": "string", "minLength": 1, "maxLength": 512 }, "message": { "type": "string", "minLength": 1, "maxLength": 131072 } } } },
  { "name": "spawn_agent", "description": "Creates a session-owned child Agent and returns after its supervised attempt starts.", "parameters": { "type": "object", "additionalProperties": false, "required": ["role", "taskName", "message"], "properties": { "role": { "type": "string", "enum": ["Explore", "Reviewer"] }, "taskName": { "type": "string", "minLength": 1, "maxLength": 64, "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]*$" }, "description": { "type": "string", "maxLength": 4096 }, "message": { "type": "string", "minLength": 1, "maxLength": 131072 }, "context": { "type": "string", "minLength": 1, "maxLength": 262144 }, "expectations": { "type": "object", "additionalProperties": false, "properties": { "questions": { "type": "array", "maxItems": 128 }, "outOfScope": { "type": "array", "maxItems": 128 } } }, "scope": { "type": "object", "additionalProperties": false, "properties": { "directories": { "type": "array", "maxItems": 128 }, "excludeGlobs": { "type": "array", "maxItems": 128 } } }, "depth": { "type": "string", "enum": ["quick", "normal", "exhaustive"] }, "allowedWriteFiles": { "type": "array", "maxItems": 128 }, "allowShell": { "type": "boolean" } } } },
  { "name": "wait_agent", "description": "Waits for unread messages from selected Agents without losing concurrent wakeups.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "targets": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 512 } }, "timeoutMs": { "type": "integer", "minimum": 0, "maximum": 300000 } } } },
  { "name": "ActivateSkill", "description": "Activate a skill for the current conversation and load its instructions. Active skills persist across turns, compaction, failures, and restart. A session-disabled skill requires force=true after an explicit user request.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "skill": { "type": "string", "minLength": 1, "maxLength": 256 }, "args": { "type": "string", "maxLength": 8192 }, "force": { "type": "boolean" } }, "required": ["skill"] } },
  { "name": "DeactivateSkill", "description": "Stop applying a skill in the current conversation. inactive permits later activation; disabled requires an explicit user request and force=true to reactivate.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "skill": { "type": "string", "minLength": 1, "maxLength": 256 }, "mode": { "type": "string", "enum": ["inactive", "disabled"] }, "reason": { "type": "string", "maxLength": 1024 } }, "required": ["skill"] } },
  { "name": "Skill", "description": "Load one available skill's trusted instructions into the current conversation. The ActivateSkill tool is preferred for persistent session state.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "skill": { "type": "string", "minLength": 1, "maxLength": 256 }, "args": { "type": "string", "maxLength": 8192 } }, "required": ["skill"] } },
  { "name": "ToolResultRead", "description": "Reads a bounded chunk from a tool-result:// handle returned by a previous tool call. It only accepts opaque handles owned by the active workspace and session, never filesystem paths.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "handle": { "type": "string", "pattern": "^tool-result://[A-Za-z0-9_-]+$" }, "offset": { "type": "integer", "minimum": 0, "default": 0 }, "limit": { "type": "integer", "minimum": 1, "maximum": 50000, "default": 20000 } }, "required": ["handle"] } },
  { "name": "AskUserQuestion", "description": "Ask the user a multiple-choice question only when their decision is required to continue.", "parameters": { "type": "object", "additionalProperties": false, "properties": { "questions": { "type": "array", "minItems": 1, "maxItems": 4, "items": { "type": "object", "additionalProperties": false, "properties": { "question": { "type": "string" }, "header": { "type": "string" }, "options": { "type": "array", "minItems": 2, "maxItems": 4, "items": { "type": "object", "additionalProperties": false, "properties": { "label": { "type": "string" }, "description": { "type": "string" }, "detail": { "type": "string" } }, "required": ["label"] } }, "multiSelect": { "type": "boolean" }, "ignoreLabel": { "type": "string" }, "submitLabel": { "type": "string" } }, "required": ["question", "header", "options"] } } }, "required": ["questions"] } }
]
```

真正 wire format 会给每项再包一层 `{"type":"function","function":{...}}`。上面的数组已经把重复 schema 逐项内联；前面的 S1/A1 小节用于便于对照，不参与替代任何参数正文。

## 真实首个 assistant/tool exchange

模型首个输出：

```json
{
  "role": "assistant",
  "content": "",
  "tool_calls": [
    {
      "id": "call_cQDKqfAv9WKAwDcDfRPiYp1Y",
      "type": "function",
      "function": {
        "name": "ActivateSkill",
        "arguments": "{\"skill\":\"using-superpowers\"}"
      }
    }
  ]
}
```

随后 tool result 把 `using-superpowers` 的完整 SKILL body 写回 history，并记录 `skill_state_updated`。这说明除 System Prompt 外，Skill tool result 也是后续上下文中非常重的一层。
