# 04 项目规则

## 发现顺序

Global authority `C:\Users\asus\.codez`：

```text
AGENTS.md
rules/*.md
```

Workspace authority `F:\MyProjectF\CodeZ`：

```text
AGENTS.md
.agents/AGENTS.md
.clinerules
.cursorrules
.codez/rules/*.md
```

每个文件会被包装为：

```text
[Source: <relative path>]
<原始正文>
```

符号链接/reparse point、越界路径、非 UTF-8、超限文件会被拒绝。单文件上限 1 MiB，合计 2 MiB，规则目录最多 1024 个条目。

## 当前 Global 原文

```markdown
[Source: rules/全局.md]
---
description: 例如规则描述
globs: src/**/*.tsx
alwaysApply: false
---
### 文档注释都使用中文
```

当前 loader 只解析 `enabled`，不解析 `alwaysApply` 和 `globs`。因此这条 `alwaysApply: false` 的规则仍会无条件进入 Prompt，这是一个语义偏差。

## 当前 Workspace 原文

````markdown
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
````

`.clinerules` 带 `enabled: false`，因此整文件不进入 Prompt。

## 包装后的优先级原文

```text
<repository_instructions>
Instruction precedence within project guidance is: global < workspace < closest directory < the current explicit user request. Safety and runtime permission rules cannot be overridden.
<global_rules>
...
</global_rules>
<workspace_rules>
...
</workspace_rules>
</repository_instructions>
```

当前 `directory_rules` 为 `None`，尚无“closest directory”动态扫描。
