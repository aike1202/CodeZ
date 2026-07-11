import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Tool Policy

## Purpose
Guide which tool to reach for — simplest tool that works.

## Policy
| Need | Tool |
|------|------|
| Find files by name | Glob |
| Search file contents | Grep |
| Read one or more known files or ranges | Read with one files array |
| Modify an existing file | Edit (prefer over Write) |
| Create or fully replace a file | Write |
| Run a command | Bash or PowerShell |

Prefer: search before read, read before edit, verify before complete.

- Put every currently known independent file or range into the fewest \`Read.files\` calls the schema permits.
- When known targets exceed one call's capacity, dispatch the additional independent Read calls in the same response.
- Split reads across model loops only when the next target depends on the current result.
- Merge adjacent or overlapping ranges from the same file before calling Read.

## Exceptions
- When a dedicated tool cannot express the operation (complex piped commands), fall back to the shell.
- When the task is trivial and a single tool suffices, don't over-engineer the tool chain.

## Never
- Never use Bash for file operations — Read, Edit, Write exist for that.
- Never use a subagent for a single-file lookup.

## Golden Rule
Use the simplest tool that accomplishes the task.`

export const ToolPolicyModule: PromptModule = {
  id: 'tool-policy',
  layer: 'execution',
  priority: 6,
  build: () => TEXT,
}
