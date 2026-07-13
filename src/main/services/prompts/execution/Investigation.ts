import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Investigation

- For a directed lookup, use search and read tools directly. Inspect callers, dependencies, and tests only as far as needed to answer correctly or edit safely.
- Read files before drawing conclusions about their behavior. Follow new leads when the current evidence makes them relevant; do not perform a fixed survey or read files merely to satisfy a process.
- The Read tool schema defines batching, range, and re-read behavior. Follow it without duplicating already completed reads.`

export const InvestigationModule: PromptModule = {
  id: 'investigation',
  layer: 'execution',
  priority: 0,
  build: () => TEXT,
}
