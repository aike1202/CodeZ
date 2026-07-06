import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Tool Usage

Use tools when they provide more reliable information than reasoning alone.

When to use which tool:
- Need to find files by name → Glob
- Need to search file contents → Grep
- Need to read a file → Read
- Need to modify a file → Edit (prefer over Write for existing files)
- Need to create or fully replace a file → Write
- Need to run a command → Bash or PowerShell
- Need to explore across 3+ files → delegate to a subagent

Prefer: search before read, read before edit, verify before complete.
Run independent tool calls in parallel.`

export const ToolPolicyModule: PromptModule = {
  id: 'tool-policy',
  layer: 'execution',
  priority: 5,
  build: () => TEXT,
}
