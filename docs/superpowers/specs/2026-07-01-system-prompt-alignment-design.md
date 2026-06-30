# CodeZ System Prompt 对齐 Claude Code 设计文档

> 创建时间：2026-07-01
> 状态：approved
> 范围：src/main/services/ + src/main/ipc/chat.handlers.ts

## 1. 目标

将 CodeZ 的系统提示词构建对齐真实 Claude Code，补全缺失的能力声明和上下文注入。

## 2. 新增文件

```
src/main/services/
├── SystemPromptService.ts    ← 系统提示词构建中心
├── GitContextService.ts      ← Git 状态快照读取
└── MemoryService.ts          ← 长期记忆目录管理

src/tests/
├── system-prompt-service.test.ts
├── git-context-service.test.ts
└── memory-service.test.ts
```

## 3. 修改文件

```
src/main/ipc/chat.handlers.ts   ← 用 SystemPromptService 替换内联构建逻辑
src/main/agent/RulesResolver.ts ← 拆分为 getGlobalRules / getWorkspaceRules
src/main/index.ts               ← 注册 MemoryService.ensureInitialized()
```

## 4. 数据流

```
chat.handlers.ts (IPC)
  │
  ├─ SystemPromptService.buildSystemPrompt(ctx)
  │     ├─ buildIdentity()                  →  身份声明
  │     ├─ buildHarnessRules()              →  Harness 规则
  │     ├─ buildMemoryDescription()         →  Memory 系统描述
  │     ├─ buildDeveloperInstructions()     →  developer_instructions
  │     │     └─ VerificationStrategyService
  │     ├─ buildRepositoryInstructions()    →  repository_instructions
  │     │     └─ RulesResolver.getWorkspaceRules()
  │     ├─ buildEnvironmentContext()        →  environment_context
  │     ├─ buildGitStatus()                 →  git_status
  │     │     └─ GitContextService.getSnapshot()
  │     ├─ buildAvailableTools()            →  available_tools
  │     │     └─ ToolManager.getAllTools()
  │     ├─ buildPendingFeatures()           →  pending_features (TODO)
  │     └─ buildAvailableSkills()           →  available_skills
  │           └─ SkillManager.getActiveSkills()
  │
  └─ SystemPromptService.buildSystemReminder()
        └─ RulesResolver.getGlobalRules()   →  <system_reminder>
```

## 5. 完整 System Prompt 布局

```
1. 身份声明: "You are a helpful AI programming assistant — CodeZ."
2. Harness 规则 (输出格式 / 并行调用 / 代码引用 / 安全 / 汇报)
3. Memory 系统描述 (路径 / 格式 / 索引 / 规则)
4. <developer_instructions> (编辑规则 / ANTI-INJECTION / CONTEXT / VERIFICATION)
5. <repository_instructions> (项目规则)
6. <environment_context> (cwd / shell / os / platform / date / model / context_window)
7. <git_status> (branch / user / porcelain status / recent commits x5)
8. <available_tools>
9. <pending_features> (AGENT_TYPES TODO)
10. <available_skills>
```

`<system_reminder>` 单独注入到 `request.messages[0]` 前面。

## 6. SystemPromptService

### 接口

```ts
interface PromptContext {
  workspaceRoot: string
  modelId: string
  modelDisplayName: string
  contextWindowTokens: number
  sessionId?: string
}

class SystemPromptService {
  static async buildSystemPrompt(ctx: PromptContext): Promise<string>
  static async buildSystemReminder(workspaceRoot: string): Promise<string>
}
```

### 子方法

| 方法 | 输入 | 来源 |
|------|------|------|
| `buildIdentity()` | 无 | 硬编码 |
| `buildHarnessRules()` | 无 | 硬编码 |
| `buildMemoryDescription()` | workspaceRoot | MemoryService.getMemoryDir() |
| `buildDeveloperInstructions()` | workspaceRoot | 硬编码 + VerificationStrategyService |
| `buildRepositoryInstructions()` | workspaceRoot | RulesResolver.getWorkspaceRules() |
| `buildEnvironmentContext()` | PromptContext | os / process / ctx |
| `buildGitStatus()` | workspaceRoot | GitContextService.getSnapshot() |
| `buildAvailableTools()` | 无 | ToolManager |
| `buildAvailableSkills()` | workspaceRoot | SkillManager |
| `buildPendingFeatures()` | 无 | 硬编码 TODO 标记 |
| `buildSystemReminder()` | workspaceRoot | RulesResolver.getGlobalRules() |

所有方法均为静态方法，无实例状态。

## 7. GitContextService

### 接口

```ts
class GitContextService {
  static async getSnapshot(workspaceRoot: string): Promise<string>
}
```

### 输出格式

```
Current branch: main

Main branch (you will usually use this for PRs): main

Git user: aike1202

Status:
M src/main/agent/ContextManager.ts
 M src/main/tools/builtin/ReadFilesTool.ts
?  CodeZlogs/

Recent commits:
1b7aba8 style(chat): enhance directory headers in list_files log detail view
42d9b28 fix(chat): correctly parse dirPaths from list_files tool for timeline UI
4f7734e feat(chat): implement interleaved chronological rendering
e9290d7 feat(chat): improve tool call target UI
2e79055 docs(plans): add interleaved chat implementation plan
```

### 实现

| 字段 | 命令 | 容错 |
|------|------|------|
| Current branch | `git rev-parse --abbrev-ref HEAD` | 失败→返回空字符串 |
| Main branch | `git symbolic-ref refs/remotes/origin/HEAD` | 失败→`"main"` |
| Git user | `git config user.name` | 失败→`"unknown"` |
| Status | `git status --porcelain` | 失败→`"(unable to read)"` |
| Recent commits | `git log --oneline -5` | 失败→跳过此段 |

所有 git 命令通过 `child_process.execSync` 执行，超时 5 秒。非 git 仓库静默返回空。

## 8. RulesResolver 拆分

```ts
class RulesResolver {
  /** 全局规则 → <system_reminder> */
  static async getGlobalRules(): Promise<string>

  /** 项目规则 → <repository_instructions> */
  static async getWorkspaceRules(workspaceRoot: string): Promise<string>
}
```

| | getGlobalRules() | getWorkspaceRules() |
|---|---|---|
| 路径 | `~/.codez/AGENTS.md`, `~/.codez/rules/*.md` | `<workspace>/AGENTS.md`, `.agents/AGENTS.md`, `.clinerules`, `.cursorrules`, `<workspace>/.codez/rules/*.md` |
| 标签 | `=== Global Rules ===` | `=== Workspace Rules ===` |

## 9. MemoryService

### 目录结构

```
~/.codez/projects/<workspace-hash>/
  memory/
    MEMORY.md           ← 索引文件
    <slug>.md           ← 记忆文件
```

### 接口

```ts
class MemoryService {
  static getMemoryDir(workspaceRoot: string): string
  static async ensureInitialized(workspaceRoot: string): Promise<void>
  static async getIndex(workspaceRoot: string): Promise<string>
  static async appendToIndex(workspaceRoot: string, entry: string): Promise<void>
}
```

### 记忆文件格式

```markdown
---
name: <short-kebab-case-slug>
description: <one-line summary>
metadata:
  type: user | feedback | project | reference
---

<fact content>

**Why:** <reason>
**How to apply:** <application guidance>

Related: [[other-memory]]
```

### System Prompt 中的 Memory 描述

见附录 A。

## 10. `<system_reminder>` 注入

注入位置：`request.messages[0]`（第一个 user message）的 content 前面。

```
<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
... (全局规则文件内容) ...
# currentDate
Today's date is 2026-07-01.
</system-reminder>

<user's original message>
```

约束：只在第一条 user message 前注入，后续消息不重复。

## 11. Harness 规则增强

新增内容（对齐真实 Claude Code）：

```text
# Harness
- Text you output outside of tool use is displayed to the user as
  Github-flavored markdown in a terminal.
- Prefer the dedicated file/search tools over shell commands when one fits.
  Independent tool calls can run in parallel in one response.
- Reference code as `file_path:line_number` — it's clickable.
- For actions that are hard to reverse or outward-facing, confirm first
  unless explicitly told to proceed without asking.
- Before deleting or overwriting, inspect the target — if what you find
  contradicts how it was described, or you didn't create it, surface
  that instead of proceeding.
- Report outcomes faithfully: if tests fail, say so with the output;
  if a step was skipped, say that; when something is done and verified,
  state it plainly without hedging.
```

## 12. AGENT_TYPES TODO 标记

```xml
<pending_features>
  The following features are planned but NOT YET IMPLEMENTED.
  Do NOT attempt to use functionality related to them.

  - AGENT_TYPES: Agent type declarations for the Agent tool.
    Only use subagents through the available tools above.
    Agent type system will be added in a future update.
</pending_features>
```

## 13. 环境上下文增强

新增字段：

| 字段 | 来源 |
|------|------|
| `shell` | 平台检测 |
| `os_version_name` | `os.release()` 映射 |
| `platform` | `process.platform` |
| `model_id` | ctx.modelId |
| `context_window` | ctx.contextWindowTokens |

## 14. 实施顺序

```
Phase 1: 基础设施（可并行）
├── 1.1 新建 GitContextService + 测试
├── 1.2 拆分 RulesResolver + 更新测试
└── 1.3 新建 MemoryService + 测试

Phase 2: 组装层
└── 2.1 新建 SystemPromptService + 测试

Phase 3: 接入
├── 3.1 重构 chat.handlers.ts
└── 3.2 main/index.ts 注册 MemoryService

Phase 4: 验证
└── 4.1 npm run typecheck && npm run test
```

## 15. 不涉及的文件

- AgentRunner.ts
- ContextManager.ts
- ToolManager.ts
- 任何 Provider.ts
- 任何 renderer 文件
- 任何 IPC handler（除 chat.handlers.ts）

## 附录 A: Memory System Prompt 描述

```text
# Memory

You have a persistent file-based memory at `<computed_path>`. Each memory
is one file holding one fact, with frontmatter:

---
name: <short-kebab-case-slug>
description: <one-line summary — used to decide relevance during recall>
metadata:
  type: user | feedback | project | reference
---

<the fact; for feedback/project, follow with **Why:** and **How to apply:**
lines. Link related memories with [[their-name]].>

In the body, link to related memories with [[name]]. A [[name]] that doesn't
match an existing memory yet is fine; it marks something worth writing later.

`user` — who the user is (role, expertise, preferences).
`feedback` — guidance the user has given on how you should work.
`project` — ongoing work, goals, or constraints not derivable from the code.
`reference` — pointers to external resources.

After writing a memory file, add a one-line entry in MEMORY.md. MEMORY.md is
the index loaded each session — one line per memory, never put content there.

Before saving, check for an existing file that already covers it — update
that file instead of creating a duplicate. Don't save what the repo already
records (code structure, past fixes, git history).
```
