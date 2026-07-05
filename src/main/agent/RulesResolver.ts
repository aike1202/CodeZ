import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

export class RulesResolver {
  /**
   * Load global user rules from ~/.codez/.
   * Used by <system_reminder> injection.
   */
  static async getGlobalRules(): Promise<string> {
    const homeDir = os.homedir()
    const globalRules: string[] = []

    globalRules.push(await this.safeReadFile(path.join(homeDir, '.codez', 'AGENTS.md')))
    globalRules.push(await this.readMarkdownFilesInDir(path.join(homeDir, '.codez', 'rules')))

    const filtered = globalRules.filter(Boolean)
    if (filtered.length === 0) return ''

    return '=== Global Rules ===\n' + filtered.join('\n\n')
  }

  /**
   * Load workspace-level rules from the project directory.
   * Used by <repository_instructions> in system prompt.
   */
  static async getWorkspaceRules(workspaceRoot: string): Promise<string> {
    const workspaceRules: string[] = []

    workspaceRules.push(await this.safeReadFile(path.join(workspaceRoot, 'AGENTS.md')))
    workspaceRules.push(await this.safeReadFile(path.join(workspaceRoot, '.agents', 'AGENTS.md')))
    workspaceRules.push(await this.safeReadFile(path.join(workspaceRoot, '.clinerules')))
    workspaceRules.push(await this.safeReadFile(path.join(workspaceRoot, '.cursorrules')))
    workspaceRules.push(await this.readMarkdownFilesInDir(path.join(workspaceRoot, '.codez', 'rules')))

    const filtered = workspaceRules.filter(Boolean)
    if (filtered.length === 0) return ''

    return '=== Workspace Rules ===\n' + filtered.join('\n\n')
  }

  private static async safeReadFile(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/
      const match = content.match(frontmatterRegex)
      if (match) {
        const yamlStr = match[1]
        const lines = yamlStr.split(/\r?\n/)
        for (const line of lines) {
          const idx = line.indexOf(':')
          if (idx > -1) {
            const key = line.slice(0, idx).trim()
            const val = line.slice(idx + 1).trim()
            if (key === 'enabled' && val === 'false') {
              return '' // skip rule if explicitly disabled
            }
          }
        }
      }
      return content.trim() ? `[Source: ${path.basename(filePath)}]\n${content.trim()}` : ''
    } catch {
      return ''
    }
  }

  private static async readMarkdownFilesInDir(dirPath: string): Promise<string> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      let contents = ''
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const content = await this.safeReadFile(path.join(dirPath, entry.name))
          if (content) contents += content + '\n\n'
        }
      }
      return contents.trim()
    } catch {
      return ''
    }
  }
}
