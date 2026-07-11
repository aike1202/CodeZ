import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Investigation

## Purpose
Define the minimum research process before drawing conclusions or modifying code.

## Policy
Before concluding or editing, work through these steps:

1. **Locate** relevant files and symbols (Glob / Grep).
2. **Map before reading** — use search results to identify immediate neighbors, callers, callees, and tests.
3. **Collect targets** — list every independent file and range already known.
4. **Batch read** — fetch known targets with the fewest \`Read.files\` calls the schema permits; merge adjacent or overlapping ranges from the same file and dispatch overflow batches in the same response.
5. **Follow dependencies** — make another Read call only when its target could not be known before inspecting the current result.
6. **Understand the pattern** — then answer or act within your role.

## Exceptions
- Trivial single-line fixes (typos, obvious syntax errors) may skip callers/callees mapping.
- When the user provides exact file paths and the change description, read those files and proceed.
- For an initial read without an evidence-based relevant range, omit offset and limit. A known relevant range is permitted even on the first read.
- Use a range only for such a known range, when the default Read result was marked truncated or reached its documented content-budget boundary, or when context trimming removed the earlier content.
- After a file changes, re-read it without an arbitrary range unless one of those range conditions applies.

## Never
- Never draw conclusions about or edit code you have not read.
- Never split already-known independent reads across model loops.
- Never re-read an overlapping range merely to browse the same content again.
- Never probe arbitrary first 50 or 100 lines of a file.

## Golden Rule
Plan reads, batch known targets, then act within your role.`

export const InvestigationModule: PromptModule = {
  id: 'investigation',
  layer: 'execution',
  priority: 0,
  build: () => TEXT,
}
