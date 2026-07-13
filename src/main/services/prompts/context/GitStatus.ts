import type { PromptModule, PromptContext } from '../PromptTypes'
export const GitStatusModule: PromptModule = {
  id: 'git-status',
  layer: 'context',
  priority: 4,
  build: (ctx: PromptContext) => {
    const snapshot = ctx.gitStatus ?? ''
    if (!snapshot) {
      return '<git_status>not a git repository or status unavailable</git_status>'
    }
    return `<git_status>\n${snapshot}\n</git_status>`
  },
}
