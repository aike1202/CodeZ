import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createHash } from 'crypto'

export class MemoryService {
  /**
   * Compute the memory directory path for a given workspace.
   * Uses ~/.codez/projects/<hash>/memory/ matching real Claude Code layout.
   */
  static getMemoryDir(workspaceRoot: string): string {
    const hash = createHash('md5').update(path.resolve(workspaceRoot)).digest('hex')
    // Map the Windows path to a valid directory name (replace colon)
    const safeHash = hash
    const homeDir = os.homedir()
    return path.join(homeDir, '.codez', 'projects', safeHash, 'memory')
  }

  /**
   * Ensure the memory directory and MEMORY.md index file exist.
   * Idempotent — safe to call multiple times.
   */
  static async ensureInitialized(workspaceRoot: string): Promise<void> {
    const memDir = this.getMemoryDir(workspaceRoot)
    await fs.mkdir(memDir, { recursive: true })

    const indexPath = path.join(memDir, 'MEMORY.md')
    try {
      await fs.access(indexPath)
    } catch {
      await fs.writeFile(indexPath, '', 'utf-8')
    }
  }

  /**
   * Read the full contents of MEMORY.md index.
   */
  static async getIndex(workspaceRoot: string): Promise<string> {
    const memDir = this.getMemoryDir(workspaceRoot)
    const indexPath = path.join(memDir, 'MEMORY.md')
    try {
      return await fs.readFile(indexPath, 'utf-8')
    } catch {
      return ''
    }
  }

  /**
   * Append a one-line entry to MEMORY.md.
   */
  static async appendToIndex(workspaceRoot: string, entry: string): Promise<void> {
    const memDir = this.getMemoryDir(workspaceRoot)
    const indexPath = path.join(memDir, 'MEMORY.md')
    const current = await this.getIndex(workspaceRoot)
    const newContent = current.trim()
      ? current.trimEnd() + '\n' + entry + '\n'
      : entry + '\n'
    await fs.writeFile(indexPath, newContent, 'utf-8')
  }
}
