import { execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'

export class GitContextService {
  /**
   * Get a formatted git status snapshot for the given workspace.
   * Returns empty string if the directory is not a git repository.
   */
  static getSnapshot(workspaceRoot: string): string {
    if (!fs.existsSync(path.join(workspaceRoot, '.git'))) {
      return ''
    }

    try {
      // Verify it's a git repo
      execSync('git rev-parse --git-dir', {
        cwd: workspaceRoot,
        timeout: 5000,
        stdio: 'pipe'
      })
    } catch {
      return ''
    }

    const run = (cmd: string): string => {
      try {
        return execSync(cmd, {
          cwd: workspaceRoot,
          timeout: 5000,
          stdio: 'pipe',
          encoding: 'utf-8'
        }).trim()
      } catch {
        return ''
      }
    }

    const currentBranch = run('git rev-parse --abbrev-ref HEAD') || 'unknown'

    let mainBranch = 'main'
    try {
      const ref = run('git symbolic-ref refs/remotes/origin/HEAD')
      if (ref) {
        mainBranch = ref.replace('refs/remotes/origin/', '').trim()
      }
    } catch {
      // Fall back to "main"
    }

    const gitUser = run('git config user.name') || 'unknown'

    const status = run('git status --porcelain') || '(unable to read)'

    const recentCommits = run('git log --oneline -5')

    const lines: string[] = []
    lines.push(`Current branch: ${currentBranch}`)
    lines.push('')
    lines.push(`Main branch (you will usually use this for PRs): ${mainBranch}`)
    lines.push('')
    lines.push(`Git user: ${gitUser}`)
    lines.push('')
    lines.push('Status:')
    lines.push(status)

    if (recentCommits) {
      lines.push('')
      lines.push('Recent commits:')
      lines.push(recentCommits)
    }

    return lines.join('\n')
  }
}
