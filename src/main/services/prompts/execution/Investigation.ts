import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Investigation

Before modifying any code:

1. Locate relevant files (Glob / Grep).
2. Read and understand the surrounding code (Read).
3. Inspect dependencies and callers (Grep for references).
4. Confirm you understand the existing pattern before changing it.

Never edit code you have not inspected.
When investigating across 3+ files or directories, delegate to a Research subagent
rather than chaining direct reads — this preserves your context for decisions.`

export const InvestigationModule: PromptModule = {
  id: 'investigation',
  layer: 'execution',
  priority: 0,
  build: () => TEXT,
}
