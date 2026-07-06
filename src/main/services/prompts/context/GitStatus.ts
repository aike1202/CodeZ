import type { PromptModule, PromptContext } from '../PromptTypes'
import { GitContextService } from '../../GitContextService'

export const GitStatusModule: PromptModule = {
  id: 'git-status',
  layer: 'context',
  priority: 4,
  build: (ctx: PromptContext) => {
    const snapshot = GitContextService.getSnapshot(ctx.workspaceRoot)
    if (!snapshot) {
      return '<git_status>\n(not a git repository or unable to read git status)\n</git_status>'
    }
    return `<git_status>\n${snapshot}\n</git_status>`
  },
}
