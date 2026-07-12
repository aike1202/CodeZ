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

Use only tools available to your role; this policy guides selection and does not grant additional capabilities.

- Put every currently known independent file or range into the fewest \`Read.files\` calls the schema permits.
- When known targets exceed one call's capacity, dispatch the additional independent Read calls in the same response.
- Split reads across model loops only when the next target depends on the current result.
- Merge adjacent or overlapping ranges from the same file before calling Read.
- For an initial read without an evidence-based relevant range, omit offset and limit. A known relevant range is permitted even on the first read.
- Do not probe arbitrary first 50 or 100 lines. Use a range only for such a known range, when the default Read result was marked truncated or reached its documented content-budget boundary, or when context trimming removed the earlier content.
- Do not Read a file merely to verify your own successful Edit or Write. Inspect the structured result and validate behavior instead; re-read when a failed mutation needs current source content, after an external change, or when needed content is no longer available in the current context.

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
