import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

interface LoadedDirectoryRule {
  rendered: string
  signature: string
}

export class RulesResolver {
  private static readonly loadedDirectoryRules = new Map<string, Map<string, LoadedDirectoryRule>>()

  /**
   * Load global user rules from ~/.codez/.
   * Used by <system_reminder> injection.
   */
  static async getGlobalRules(): Promise<string> {
    const homeDir = os.homedir()
    const globalRules = await Promise.all([
      this.safeReadFile(path.join(homeDir, '.codez', 'AGENTS.md')),
      this.readMarkdownFilesInDir(path.join(homeDir, '.codez', 'rules'))
    ])

    const filtered = globalRules.filter(Boolean)
    if (filtered.length === 0) return ''

    return filtered.join('\n\n')
  }

  /**
   * Load workspace-level rules from the project directory.
   * Used by <repository_instructions> in system prompt.
   */
  static async getWorkspaceRules(workspaceRoot: string): Promise<string> {
    const workspaceRules = await Promise.all([
      this.safeReadFile(path.join(workspaceRoot, 'AGENTS.md')),
      this.safeReadFile(path.join(workspaceRoot, '.agents', 'AGENTS.md')),
      this.safeReadFile(path.join(workspaceRoot, '.clinerules')),
      this.safeReadFile(path.join(workspaceRoot, '.cursorrules')),
      this.readMarkdownFilesInDir(path.join(workspaceRoot, '.codez', 'rules'))
    ])

    const filtered = workspaceRules.filter(Boolean)
    if (filtered.length === 0) return ''

    return filtered.join('\n\n')
  }

  static getLoadedDirectoryRules(sessionId?: string): string {
    if (!sessionId) return ''
    return [...(this.loadedDirectoryRules.get(sessionId)?.values() || [])]
      .map(rule => rule.rendered)
      .join('\n\n')
  }

  static async loadDirectoryRulesForFiles(
    workspaceRoot: string,
    filePaths: readonly string[],
    sessionId?: string
  ): Promise<string> {
    if (!sessionId || filePaths.length === 0) return ''
    const root = path.resolve(workspaceRoot)
    const candidatePaths = new Set<string>()

    for (const filePath of filePaths) {
      const absolute = path.resolve(filePath)
      const relative = path.relative(root, absolute)
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue
      const directories: string[] = []
      let current = path.dirname(absolute)
      while (current !== root) {
        const parent = path.dirname(current)
        if (parent === current || path.relative(root, current).startsWith('..')) break
        directories.unshift(current)
        current = parent
      }
      for (const directory of directories) {
        candidatePaths.add(path.join(directory, 'AGENTS.md'))
      }
    }

    let loaded = this.loadedDirectoryRules.get(sessionId)
    if (!loaded) {
      loaded = new Map<string, LoadedDirectoryRule>()
      this.loadedDirectoryRules.set(sessionId, loaded)
    }
    const fresh: string[] = []
    for (const rulePath of candidatePaths) {
      const key = process.platform === 'win32' ? rulePath.toLowerCase() : rulePath
      const stat = await fs.stat(rulePath).catch(() => null)
      if (!stat?.isFile()) {
        loaded.delete(key)
        continue
      }
      const signature = `${stat.size}:${stat.mtimeMs}`
      if (loaded.get(key)?.signature === signature) continue
      const content = await this.safeReadFile(rulePath)
      if (!content) {
        loaded.delete(key)
        continue
      }
      const scope = path.relative(root, path.dirname(rulePath)) || '.'
      const rendered = `[Directory scope: ${scope}]\n${content}`
      loaded.set(key, { rendered, signature })
      fresh.push(rendered)
    }

    while (loaded.size > 100) loaded.delete(loaded.keys().next().value as string)
    while (this.loadedDirectoryRules.size > 50) {
      this.loadedDirectoryRules.delete(this.loadedDirectoryRules.keys().next().value as string)
    }
    if (fresh.length === 0) return ''
    return [
      '<directory_instructions>',
      'The following rules were loaded by CodeZ for files just read. More specific directory rules override workspace and global project rules.',
      ...fresh,
      '</directory_instructions>'
    ].join('\n')
  }

  static clearLoadedDirectoryRules(sessionId?: string): void {
    if (sessionId) this.loadedDirectoryRules.delete(sessionId)
    else this.loadedDirectoryRules.clear()
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
      const files = entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
        .sort((a, b) => a.name.localeCompare(b.name))
      const contents = await Promise.all(files.map(entry =>
        this.safeReadFile(path.join(dirPath, entry.name))))
      return contents.filter(Boolean).join('\n\n')
    } catch {
      return ''
    }
  }
}
