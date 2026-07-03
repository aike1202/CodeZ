// src/main/services/prompts/sections/GitStatus.ts
import { GitContextService } from '../../GitContextService'

export function buildGitStatus(workspaceRoot: string): string {
  const snapshot = GitContextService.getSnapshot(workspaceRoot)
  if (!snapshot) {
    return '<git_status>\n(not a git repository or unable to read git status)\n</git_status>'
  }
  return `<git_status>\n${snapshot}\n</git_status>`
}
