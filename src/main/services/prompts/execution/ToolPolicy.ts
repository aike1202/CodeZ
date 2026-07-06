import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Tool Selection

## Purpose
Guide which tool to reach for — simplest tool that works.

## Policy
| Need | Tool |
|------|------|
| Find files by name | Glob |
| Search file contents | Grep |
| Read a file | Read |
| Modify an existing file | Edit (prefer over Write) |
| Create or fully replace a file | Write |
| Run a command | Bash or PowerShell |

Prefer: search before read, read before edit, verify before complete.

## Exceptions
- When a dedicated tool cannot express the operation (complex piped commands), fall back to the shell.
- When the task is trivial and a single tool suffices, don't over-engineer the tool chain.

## Never
- Never use Bash for file operations — Read, Edit, Write exist for that.
- Never use a subagent for a single-file lookup (see Delegation Policy).

## Golden Rule
Use the simplest tool that accomplishes the task.`

export const ToolPolicyModule: PromptModule = {
  id: 'tool-policy',
  layer: 'execution',
  priority: 6,
  build: () => TEXT,
}
