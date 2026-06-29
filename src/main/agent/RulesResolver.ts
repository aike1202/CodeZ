import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

export class RulesResolver {
  static async getRules(workspaceRoot: string): Promise<string> {
    let combinedRules = ''

    // 1. Global Rules
    const globalRules: string[] = []
    const homeDir = os.homedir()
    
    // Global ~/.codez/AGENTS.md
    globalRules.push(await this.safeReadFile(path.join(homeDir, '.codez', 'AGENTS.md')))
    // Global ~/.codez/rules/*.md
    globalRules.push(await this.readMarkdownFilesInDir(path.join(homeDir, '.codez', 'rules')))

    const filteredGlobal = globalRules.filter(Boolean)
    if (filteredGlobal.length > 0) {
      combinedRules += '=== Global Rules ===\n' + filteredGlobal.join('\n\n') + '\n\n'
    }

    // 2. Workspace Rules
    const workspaceRules: string[] = []
    
    workspaceRules.push(await this.safeReadFile(path.join(workspaceRoot, 'AGENTS.md')))
    workspaceRules.push(await this.safeReadFile(path.join(workspaceRoot, '.agents', 'AGENTS.md')))
    workspaceRules.push(await this.safeReadFile(path.join(workspaceRoot, '.clinerules')))
    workspaceRules.push(await this.safeReadFile(path.join(workspaceRoot, '.cursorrules')))
    // Workspace .codez/rules/*.md
    workspaceRules.push(await this.readMarkdownFilesInDir(path.join(workspaceRoot, '.codez', 'rules')))

    const filteredWorkspace = workspaceRules.filter(Boolean)
    if (filteredWorkspace.length > 0) {
      combinedRules += '=== Workspace Rules ===\n' + filteredWorkspace.join('\n\n') + '\n\n'
    }

    return combinedRules.trim()
  }

  private static async safeReadFile(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8')
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
