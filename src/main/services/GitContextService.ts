import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export class GitContextService {
  /**
   * Get a formatted git status snapshot for the given workspace.
   * Returns empty string if the directory is not a git repository.
   */
  static async getSnapshot(workspaceRoot: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--short', '--branch'], {
        cwd: workspaceRoot,
        timeout: 5000,
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
        windowsHide: true
      })
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
      if (lines.length === 0) return 'Branch: unknown\nWorking tree: clean'
      const branch = lines[0].replace(/^##\s*/, '')
      const changes = lines.slice(1)
      const visibleChanges = changes.slice(0, 40)
      return [
        `Branch: ${branch}`,
        `Working tree: ${changes.length === 0 ? 'clean' : `${changes.length} changed path(s)`}`,
        ...visibleChanges,
        ...(changes.length > visibleChanges.length
          ? [`... ${changes.length - visibleChanges.length} more changed path(s)`]
          : [])
      ].join('\n')
    } catch {
      return ''
    }
  }
}
