import * as fs from 'fs/promises'
import * as path from 'path'
import type { FileTreeNode, FileContent, ProjectInfo } from '../../shared/types/workspace'
import {
  DEFAULT_IGNORED_DIRS,
  BINARY_EXTENSIONS,
  MAX_FILE_READ_BYTES,
  MAX_FILE_READ_LINES,
  MAX_FILE_REJECT_BYTES
} from '../../shared/constants/ignored'

function isPathSafe(workspaceRoot: string, targetPath: string): boolean {
  const resolvedRoot = path.resolve(workspaceRoot)
  const resolvedTarget = path.resolve(targetPath)
  return resolvedTarget.startsWith(resolvedRoot + path.sep) || resolvedTarget === resolvedRoot
}

function normalizePath(workspaceRoot: string, filePath: string): string {
  const absolute = path.resolve(workspaceRoot, filePath)
  if (!isPathSafe(workspaceRoot, absolute)) {
    throw new Error(`路径不在 Workspace 范围内: ${filePath}`)
  }
  return absolute
}

function isBinaryByExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return BINARY_EXTENSIONS.includes(ext)
}

const PROJECT_DETECTORS: Array<{
  file: string
  type: string
  framework?: string
  packageManager?: string
}> = [
  { file: 'package.json', type: 'nodejs' },
  { file: 'vite.config.ts', type: 'nodejs', framework: 'vite' },
  { file: 'vite.config.js', type: 'nodejs', framework: 'vite' },
  { file: 'next.config.js', type: 'nodejs', framework: 'next' },
  { file: 'next.config.mjs', type: 'nodejs', framework: 'next' },
  { file: 'next.config.ts', type: 'nodejs', framework: 'next' },
  { file: 'pyproject.toml', type: 'python' },
  { file: 'requirements.txt', type: 'python' },
  { file: 'Cargo.toml', type: 'rust' },
  { file: 'go.mod', type: 'go' },
  { file: 'pom.xml', type: 'java', framework: 'maven' },
  { file: 'build.gradle', type: 'java', framework: 'gradle' },
  { file: 'build.gradle.kts', type: 'java', framework: 'gradle' }
]

export class WorkspaceService {
  private rootPath: string

  constructor(rootPath: string) {
    this.rootPath = path.resolve(rootPath)
  }

  getCurrentWorkspace(): string {
    return this.rootPath
  }

  validatePath(filePath: string): string {
    return normalizePath(this.rootPath, filePath)
  }

  async scanFileTree(dirPath?: string): Promise<FileTreeNode[]> {
    const targetDir = dirPath ? this.validatePath(dirPath) : this.rootPath
    const entries: FileTreeNode[] = []

    try {
      const items = await fs.readdir(targetDir, { withFileTypes: true })

      const dirs: FileTreeNode[] = []
      const files: FileTreeNode[] = []

      for (const item of items) {
        const fullPath = path.join(targetDir, item.name)
        const relativePath = path.relative(this.rootPath, fullPath)

        if (item.isDirectory()) {
          if (DEFAULT_IGNORED_DIRS.includes(item.name)) {
            continue
          }
          if (item.name.startsWith('.') && item.name !== '.gitignore') {
            // 隐藏目录默认忽略
            continue
          }
          dirs.push({
            name: item.name,
            path: relativePath,
            type: 'directory',
            children: []
          })
        } else if (item.isFile()) {
          const ext = path.extname(item.name).toLowerCase()
          // 跳过常见忽略扩展名
          if (['.exe', '.dll', '.obj', '.o', '.class', '.pyc', '.lock'].includes(ext)) {
            continue
          }
          try {
            const stat = await fs.stat(fullPath)
            files.push({
              name: item.name,
              path: relativePath,
              type: 'file',
              size: stat.size,
              extension: ext || undefined
            })
          } catch {
            // 跳过无法 stat 的文件
          }
        }
      }

      dirs.sort((a, b) => a.name.localeCompare(b.name))
      files.sort((a, b) => a.name.localeCompare(b.name))

      entries.push(...dirs, ...files)
    } catch (error) {
      console.error(`scanFileTree error for ${targetDir}:`, error)
    }

    return entries
  }

  async getAllPaths(): Promise<Array<{ name: string; path: string; isDir: boolean }>> {
    const results: Array<{ name: string; path: string; isDir: boolean }> = []
    const queue: string[] = [this.rootPath]
    
    // Safety check to avoid scanning too many files
    let scannedCount = 0
    const MAX_FILES = 50000

    while (queue.length > 0 && scannedCount < MAX_FILES) {
      const currentDir = queue.shift()!
      try {
        const items = await fs.readdir(currentDir, { withFileTypes: true })
        for (const item of items) {
          scannedCount++
          if (DEFAULT_IGNORED_DIRS.includes(item.name)) continue
          if (item.name.startsWith('.') && item.name !== '.gitignore') continue
          
          const fullPath = path.join(currentDir, item.name)
          const relativePath = path.relative(this.rootPath, fullPath)
          
          if (item.isDirectory()) {
            results.push({ name: item.name, path: relativePath, isDir: true })
            queue.push(fullPath)
          } else if (item.isFile()) {
            const ext = path.extname(item.name).toLowerCase()
            if (['.exe', '.dll', '.obj', '.o', '.class', '.pyc', '.lock'].includes(ext)) continue
            results.push({ name: item.name, path: relativePath, isDir: false })
          }
        }
      } catch (error) {
        // Skip directories we can't read
      }
    }
    
    // Sort directories first, then alphabetically
    return results.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1
      if (!a.isDir && b.isDir) return 1
      return a.path.localeCompare(b.path)
    })
  }

  async readFileContent(filePath: string): Promise<FileContent> {
    const absolutePath = this.validatePath(filePath)

    try {
      const stat = await fs.stat(absolutePath)

      if (stat.isDirectory()) {
        const files = await fs.readdir(absolutePath)
        return {
          path: filePath,
          content: `[目录预览] ${filePath}\n\n该路径是一个文件夹目录，包含以下内容：\n\n${files.map(f => `  📁 ${f}`).join('\n')}`,
          truncated: false,
          totalLines: files.length
        }
      }

      if (stat.size > MAX_FILE_REJECT_BYTES) {
        return {
          path: filePath,
          content: `[文件过大，无法预览] 文件大小: ${(stat.size / 1024 / 1024).toFixed(1)} MB，上限: 5 MB`,
          truncated: true,
          totalLines: 0
        }
      }

      if (isBinaryByExtension(absolutePath)) {
        return {
          path: filePath,
          content: `[二进制文件，不支持预览] 类型: ${path.extname(filePath) || '未知'}`,
          truncated: false,
          totalLines: 0
        }
      }

      const buffer = await fs.readFile(absolutePath)

      // magic bytes 检测二进制
      if (this.containsNullBytes(buffer.subarray(0, 512))) {
        return {
          path: filePath,
          content: '[二进制文件/编码不支持，无法预览]',
          truncated: false,
          totalLines: 0
        }
      }

      let content = buffer.toString('utf-8')
      let truncated = false

      if (stat.size > MAX_FILE_READ_BYTES) {
        const lines = content.split('\n')
        if (lines.length > MAX_FILE_READ_LINES) {
          content = lines.slice(0, MAX_FILE_READ_LINES).join('\n')
          truncated = true
        }
      }

      const totalLines = content.split('\n').length

      return {
        path: filePath,
        content,
        truncated,
        totalLines
      }
    } catch (error) {
      return {
        path: filePath,
        content: `[读取文件失败] ${error instanceof Error ? error.message : String(error)}`,
        truncated: false,
        totalLines: 0
      }
    }
  }

  async detectProjectType(rootPath?: string): Promise<ProjectInfo> {
    const targetDir = rootPath ? this.validatePath(rootPath) : this.rootPath

    for (const detector of PROJECT_DETECTORS) {
      try {
        await fs.access(path.join(targetDir, detector.file))
        return {
          type: detector.type,
          framework: detector.framework,
          packageManager: detector.packageManager
        }
      } catch {
        // 文件不存在，继续
      }
    }

    return { type: 'unknown' }
  }

  private containsNullBytes(buffer: Buffer): boolean {
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === 0) {
        return true
      }
    }
    return false
  }
}
