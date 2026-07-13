import type { PromptModule, PromptContext } from '../PromptTypes'
import { MemoryService } from '../../MemoryService'

export const MemoryModule: PromptModule = {
  id: 'memory',
  layer: 'context',
  priority: 0,
  build: (ctx: PromptContext) => {
    const memDir = MemoryService.getMemoryDir(ctx.workspaceRoot)
    return `# Memory

Persistent memory is stored at \`${memDir}\`. Save only durable user preferences, corrections, project constraints, or external references that will matter in future conversations. Use one focused markdown file per memory and keep a one-line pointer in \`MEMORY.md\`; update existing memories instead of duplicating them.

Do not store facts already recorded by the repository. Treat memory as potentially stale and verify repository state before relying on it.`
  },
}
