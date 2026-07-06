import type { PromptModule, PromptContext } from '../PromptTypes'
import { MemoryService } from '../../MemoryService'

export const MemoryModule: PromptModule = {
  id: 'memory',
  layer: 'context',
  priority: 0,
  build: (ctx: PromptContext) => {
    const memDir = MemoryService.getMemoryDir(ctx.workspaceRoot)
    return [
      '# Memory',
      '',
      `You have a persistent file-based memory at \`${memDir}\`. Each memory is one file with frontmatter:`,
      '',
      '```markdown',
      '---',
      'name: <short-kebab-case-slug>',
      'description: <one-line summary>',
      'metadata:',
      '  type: user | feedback | project | reference',
      '---',
      '',
      '<the fact; for feedback/project, follow with **Why:** and **How to apply:** lines.>',
      '```',
      '',
      '- `user` — who the user is (role, expertise, preferences).',
      '- `feedback` — how you should work (corrections + confirmed approaches).',
      '- `project` — ongoing work, goals, constraints; convert relative dates to absolute.',
      '- `reference` — pointers to external resources (URLs, dashboards, tickets).',
      '',
      'After writing, add a one-line pointer in `MEMORY.md`. Update existing files instead of duplicating.',
      '',
      'When memories conflict: prefer newer information, prefer explicit user corrections,',
      'verify repository-related memories before relying on them.',
      '',
      'Do not store what the repo already records (code structure, git history, AGENTS.md).'
    ].join('\n')
  },
}
