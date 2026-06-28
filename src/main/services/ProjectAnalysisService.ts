import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { app } from 'electron'
import {
  DEFAULT_IGNORED_DIRS,
  DEFAULT_IGNORED_EXTENSIONS,
  MAX_FILE_READ_BYTES,
  MAX_FILE_READ_LINES,
  MAX_FILE_REJECT_BYTES,
  BINARY_EXTENSIONS,
} from '../../shared/constants/ignored'
import type {
  ProjectSnapshot,
  ProjectSnapshotOptions,
  ReadManyFilesResult,
  SearchCodeOptions,
  CodeSearchResult,
  SymbolMapOptions,
  SymbolMapResult,
} from '../../shared/types/project-analysis'

const SNAPSHOT_CACHE_FILE = 'project-snapshots.json'
const DEFAULT_TREE_DEPTH = 3
const DEFAULT_MAX_TREE_ENTRIES = 300
const DEFAULT_MAX_SEARCH_RESULTS = 80
const DEFAULT_CONTEXT_LINES = 2
const DEFAULT_SYMBOL_LIMIT = 300
const DEFAULT_MAX_CHARS_PER_FILE = 40_000

interface PackageJsonShape {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  main?: string
}

interface SnapshotCacheEntry {
  rootPath: string
  packageJsonHash?: string
  lockfileHash?: string
  options?: ProjectSnapshotOptions
  snapshot: ProjectSnapshot
}

interface SnapshotCacheFile {
  entries: Record<string, SnapshotCacheEntry>
}

function isSameOptions(opt1?: ProjectSnapshotOptions, opt2?: ProjectSnapshotOptions): boolean {
  if (!opt1 || !opt2) return opt1 === opt2
  const paths1 = Array.isArray(opt1.dirPaths) ? opt1.dirPaths.slice().sort().join(',') : (opt1.dirPath || '.')
  const paths2 = Array.isArray(opt2.dirPaths) ? opt2.dirPaths.slice().sort().join(',') : (opt2.dirPath || '.')
  return (
    paths1 === paths2 &&
    (opt1.maxDepth ?? 3) === (opt2.maxDepth ?? 3) &&
    (opt1.includeFiles !== false) === (opt2.includeFiles !== false)
  )
}

function isPathSafe(workspaceRoot: string, targetPath: string): boolean {
  const resolvedRoot = path.resolve(workspaceRoot)
  const resolvedTarget = path.resolve(targetPath)
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep)
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/')
}

function shouldIgnoreName(name: string): boolean {
  return DEFAULT_IGNORED_DIRS.includes(name) || name === '.continue' || name.startsWith('.git')
}

function isIgnoredFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return DEFAULT_IGNORED_EXTENSIONS.includes(ext) || BINARY_EXTENSIONS.includes(ext)
}

function isTextLikeFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  if (!ext) return false
  return !isIgnoredFile(filePath)
}

function stableRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  return value as Record<string, string>
}

export class ProjectAnalysisService {
  private rootPath: string
  private cacheFilePath: string

  constructor(rootPath: string, cacheDir?: string) {
    this.rootPath = path.resolve(rootPath)
    const userDataPath = cacheDir || app?.getPath?.('userData') || path.join(this.rootPath, '.codez-cache')
    this.cacheFilePath = path.join(userDataPath, SNAPSHOT_CACHE_FILE)
  }

  validatePath(relativePath: string = '.'): string {
    const absolute = path.resolve(this.rootPath, relativePath)
    if (!isPathSafe(this.rootPath, absolute)) {
      throw new Error(`路径不在 Workspace 范围内: ${relativePath}`)
    }
    return absolute
  }

  async getProjectSnapshot(options: ProjectSnapshotOptions = {}): Promise<ProjectSnapshot> {
    const packageJsonHash = await this.hashOptionalFile('package.json')
    const lockfileHash = await this.hashFirstExisting(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])
    const cached = await this.readCache()
    const cacheEntry = cached.entries[this.rootPath]

    if (!options.forceRefresh && cacheEntry && cacheEntry.packageJsonHash === packageJsonHash && cacheEntry.lockfileHash === lockfileHash && isSameOptions(cacheEntry.options, options)) {
      return {
        ...cacheEntry.snapshot,
        fromCache: true,
      }
    }

    const packageJson = await this.readPackageJson()
    const scripts = stableRecord(packageJson?.scripts)
    const dependencies = stableRecord(packageJson?.dependencies)
    const devDependencies = stableRecord(packageJson?.devDependencies)
    const projectType = this.detectProjectType(packageJson)
    const packageManager = await this.detectPackageManager()
    const configFiles = await this.findExistingFiles([
      'package.json',
      'README.md',
      'electron.vite.config.ts',
      'electron.vite.config.js',
      'vite.config.ts',
      'vite.config.js',
      'tsconfig.json',
      'vitest.config.ts',
      'jest.config.js',
    ])
    const entrypoints = await this.findEntrypoints(packageJson)
    const recommendedFiles = await this.findRecommendedFiles(projectType, entrypoints)

    // 支持批量目录快照
    let targetPaths: string[] = []
    if (Array.isArray(options.dirPaths)) {
      targetPaths = options.dirPaths
    } else if (typeof options.dirPath === 'string') {
      targetPaths = [options.dirPath]
    } else {
      targetPaths = ['.']
    }

    const treeParts: string[] = []
    for (const dir of targetPaths) {
      const dirTree = await this.buildTree(dir, options.maxDepth || DEFAULT_TREE_DEPTH, options.includeFiles !== false)
      if (targetPaths.length > 1) {
        treeParts.push(`=== Directory: ${dir} ===\n${dirTree}`)
      } else {
        treeParts.push(dirTree)
      }
    }
    const tree = treeParts.join('\n\n')

    const snapshot: ProjectSnapshot = {
      rootName: path.basename(this.rootPath),
      rootPath: this.rootPath,
      projectType,
      packageManager,
      scripts,
      dependencies,
      devDependencies,
      configFiles,
      entrypoints,
      recommendedFiles,
      tree,
      fromCache: false,
      updatedAt: new Date().toISOString(),
    }

    cached.entries[this.rootPath] = {
      rootPath: this.rootPath,
      packageJsonHash,
      lockfileHash,
      options,
      snapshot,
    }
    await this.writeCache(cached)

    return snapshot
  }

  async getFastContext(targetPaths: string[], maxDepth: number = 2, maxCharsPerFile: number = 15000): Promise<string> {
    const tasks = targetPaths.map(async (targetPath) => {
      try {
        const absolutePath = this.validatePath(targetPath)
        const stat = await fs.stat(absolutePath)
        
        if (stat.isDirectory()) {
          const tree = await this.buildTree(targetPath, maxDepth, true)
          return `\n=== Directory: ${targetPath} ===\n[Directory Tree]\n${tree}\n`
        } else if (stat.isFile()) {
          const fileResult = await this.readOneFile(targetPath, maxCharsPerFile)
          return `\n=== File: ${targetPath} ===\n${fileResult.content}`
        }
      } catch (err: any) {
        return `\n=== Target: ${targetPath} ===\nError: ${err.message}`
      }
      return ''
    })
    
    const results = await Promise.all(tasks)
    return results.join('\n').trim()
  }

  async readManyFiles(filePaths: string[], maxCharsPerFile: number = DEFAULT_MAX_CHARS_PER_FILE): Promise<ReadManyFilesResult> {
    const files = await Promise.all(filePaths.map(async (filePath) => this.readOneFile(filePath, maxCharsPerFile)))
    return { files }
  }

  private async getAllFiles(startDir: string): Promise<string[]> {
    const filePaths: string[] = []
    
    const scan = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      const tasks = entries.map(async (entry) => {
        const absolutePath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!shouldIgnoreName(entry.name)) {
            await scan(absolutePath)
          }
        } else if (entry.isFile() && isTextLikeFile(entry.name)) {
          filePaths.push(absolutePath)
        }
      })
      await Promise.all(tasks)
    }
    
    await scan(startDir)
    return filePaths
  }

  async searchCode(options: SearchCodeOptions): Promise<CodeSearchResult> {
    const maxResults = options.maxResults || DEFAULT_MAX_SEARCH_RESULTS
    const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES
    const targetDir = this.validatePath(options.dirPath || '.')
    const query = options.query
    const results: CodeSearchResult['matches'] = []
    const matcher = this.createMatcher(query)

    const allFiles = await this.getAllFiles(targetDir)
    const concurrencyLimit = 50

    for (let i = 0; i < allFiles.length; i += concurrencyLimit) {
      if (results.length >= maxResults) break
      const batch = allFiles.slice(i, i + concurrencyLimit)
      await Promise.all(
        batch.map(async (absolutePath) => {
          if (results.length >= maxResults) return
          const relativePath = toPosixPath(path.relative(this.rootPath, absolutePath))
          if (!this.matchesAnyGlob(relativePath, options.includeGlobs)) return

          try {
            const content = await fs.readFile(absolutePath, 'utf-8')
            const lines = content.split('\n')
            lines.forEach((line, index) => {
              if (results.length >= maxResults) return
              if (!matcher(line)) return
              const beforeStart = Math.max(0, index - contextLines)
              const afterEnd = Math.min(lines.length, index + contextLines + 1)
              results.push({
                path: relativePath,
                line: index + 1,
                text: line,
                before: lines.slice(beforeStart, index),
                after: lines.slice(index + 1, afterEnd),
              })
            })
          } catch {
            // skip
          }
        })
      )
    }

    return {
      matches: results,
      truncated: results.length >= maxResults,
    }
  }

  async getSymbolMap(options: SymbolMapOptions = {}): Promise<SymbolMapResult> {
    const maxResults = options.maxResults || DEFAULT_SYMBOL_LIMIT
    const targetDir = this.validatePath(options.dirPath || '.')
    const symbols: SymbolMapResult['symbols'] = []

    const allFiles = await this.getAllFiles(targetDir)
    const concurrencyLimit = 50

    for (let i = 0; i < allFiles.length; i += concurrencyLimit) {
      if (symbols.length >= maxResults) break
      const batch = allFiles.slice(i, i + concurrencyLimit)
      await Promise.all(
        batch.map(async (absolutePath) => {
          if (symbols.length >= maxResults) return
          const relativePath = toPosixPath(path.relative(this.rootPath, absolutePath))
          if (!/\.(ts|tsx|js|jsx)$/i.test(relativePath)) return

          try {
            const content = await fs.readFile(absolutePath, 'utf-8')
            const lines = content.split('\n')
            lines.forEach((line, index) => {
              if (symbols.length >= maxResults) return
              this.extractSymbolsFromLine(line).forEach((symbol) => {
                if (symbols.length >= maxResults) return
                symbols.push({
                  ...symbol,
                  path: relativePath,
                  line: index + 1,
                })
              })
            })
          } catch {
            // skip
          }
        })
      )
    }

    return {
      symbols,
      truncated: symbols.length >= maxResults,
    }
  }

  private async readOneFile(filePath: string, maxCharsPerFile: number): Promise<ReadManyFilesResult['files'][number]> {
    try {
      const absolutePath = this.validatePath(filePath)
      const stat = await fs.stat(absolutePath)
      if (stat.size > MAX_FILE_REJECT_BYTES) {
        return {
          path: filePath,
          content: `[文件过大，无法读取] ${(stat.size / 1024 / 1024).toFixed(1)} MB`,
          truncated: true,
          totalLines: 0,
        }
      }
      if (isIgnoredFile(absolutePath)) {
        return {
          path: filePath,
          content: '[二进制文件或忽略类型，跳过读取]',
          truncated: false,
          totalLines: 0,
        }
      }

      const buffer = await fs.readFile(absolutePath)
      if (buffer.subarray(0, 512).includes(0)) {
        return {
          path: filePath,
          content: '[二进制文件/编码不支持，无法读取]',
          truncated: false,
          totalLines: 0,
        }
      }

      let content = buffer.toString('utf-8')
      const allLines = content.split('\n')
      let truncated = false
      if (content.length > maxCharsPerFile) {
        content = content.slice(0, maxCharsPerFile)
        truncated = true
      }
      if (allLines.length > MAX_FILE_READ_LINES) {
        content = allLines.slice(0, MAX_FILE_READ_LINES).join('\n')
        truncated = true
      }

      return {
        path: filePath,
        content,
        truncated,
        totalLines: allLines.length,
      }
    } catch (error) {
      return {
        path: filePath,
        content: '',
        truncated: false,
        totalLines: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async readPackageJson(): Promise<PackageJsonShape | null> {
    try {
      const absolutePath = this.validatePath('package.json')
      const content = await fs.readFile(absolutePath, 'utf-8')
      return JSON.parse(content) as PackageJsonShape
    } catch {
      return null
    }
  }

  private detectProjectType(packageJson: PackageJsonShape | null): string {
    if (!packageJson) return 'unknown'
    const dependencies = {
      ...stableRecord(packageJson.dependencies),
      ...stableRecord(packageJson.devDependencies),
    }
    const hasElectron = Boolean(dependencies.electron || dependencies['electron-vite'])
    const hasReact = Boolean(dependencies.react || dependencies['@vitejs/plugin-react'])
    const hasVite = Boolean(dependencies.vite || dependencies['@vitejs/plugin-react'])

    if (hasElectron && hasReact) return 'electron-react'
    if (hasReact && hasVite) return 'react-vite'
    return 'nodejs'
  }

  private async detectPackageManager(): Promise<string> {
    if (await this.exists('pnpm-lock.yaml')) return 'pnpm'
    if (await this.exists('yarn.lock')) return 'yarn'
    if (await this.exists('package-lock.json')) return 'npm'
    if (await this.exists('package.json')) return 'npm'
    return 'unknown'
  }

  private async findEntrypoints(packageJson: PackageJsonShape | null): Promise<string[]> {
    const candidates = [
      packageJson?.main?.replace(/^\.\//, ''),
      'src/main/index.ts',
      'src/main/index.js',
      'src/preload/index.ts',
      'src/preload/index.js',
      'src/renderer/src/App.tsx',
      'src/renderer/src/main.tsx',
      'src/renderer/src/main.ts',
      'src/shared/ipc/channels.ts',
    ].filter(Boolean) as string[]
    return this.findExistingFiles(candidates)
  }

  private async findRecommendedFiles(projectType: string, entrypoints: string[]): Promise<string[]> {
    const common = [
      'package.json',
      'README.md',
      'electron.vite.config.ts',
      'vite.config.ts',
      'tsconfig.json',
      'vitest.config.ts',
    ]
    const electronReact = [
      'src/main/agent/AgentRunner.ts',
      'src/main/services/ChatService.ts',
      'src/main/services/ProviderService.ts',
      'src/main/services/WorkspaceService.ts',
      'src/main/tools/ToolManager.ts',
      'src/preload/index.ts',
      'src/renderer/src/App.tsx',
      'src/renderer/src/stores/chatStore.ts',
      'src/renderer/src/stores/providerStore.ts',
      'src/renderer/src/components/chat/ExecutionLog.tsx',
      'src/shared/types/provider.ts',
    ]
    const candidates = projectType === 'electron-react'
      ? [...common, ...entrypoints, ...electronReact]
      : [...common, ...entrypoints]
    return this.findExistingFiles(Array.from(new Set(candidates)))
  }

  private async buildTree(dirPath: string, maxDepth: number, includeFiles: boolean): Promise<string> {
    const rootDir = this.validatePath(dirPath)
    const lines: string[] = [toPosixPath(path.relative(this.rootPath, rootDir)) || '.']
    let count = 0

    const visit = async (directory: string, depth: number, prefix: string): Promise<void> => {
      if (depth >= maxDepth || count >= DEFAULT_MAX_TREE_ENTRIES) return
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
      const filtered = entries
        .filter((entry) => {
          if (entry.isDirectory()) return !shouldIgnoreName(entry.name)
          return includeFiles && entry.isFile() && !isIgnoredFile(entry.name)
        })
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))

      for (const entry of filtered) {
        if (count >= DEFAULT_MAX_TREE_ENTRIES) break
        const fullPath = path.join(directory, entry.name)
        const marker = entry.isDirectory() ? '[DIR]' : '[FILE]'
        lines.push(`${prefix}${marker} ${entry.name}`)
        count++
        if (entry.isDirectory()) {
          await visit(fullPath, depth + 1, `${prefix}  `)
        }
      }
    }

    await visit(rootDir, 0, '')
    if (count >= DEFAULT_MAX_TREE_ENTRIES) {
      lines.push('[TRUNCATED] tree output limit reached')
    }
    return lines.join('\n')
  }

  private async walkFiles(startDir: string, onFile: (absolutePath: string) => Promise<void>): Promise<void> {
    const entries = await fs.readdir(startDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const absolutePath = path.join(startDir, entry.name)
      if (entry.isDirectory()) {
        if (shouldIgnoreName(entry.name)) continue
        await this.walkFiles(absolutePath, onFile)
        continue
      }
      if (!entry.isFile() || !isTextLikeFile(entry.name)) continue
      await onFile(absolutePath)
    }
  }

  private createMatcher(query: string): (line: string) => boolean {
    try {
      const regex = new RegExp(query, 'i')
      return (line) => regex.test(line)
    } catch {
      const lower = query.toLowerCase()
      return (line) => line.toLowerCase().includes(lower)
    }
  }

  private matchesAnyGlob(filePath: string, globs?: string[]): boolean {
    if (!globs || globs.length === 0) return true
    return globs.some((glob) => {
      const normalized = glob.replace(/\\/g, '/')
      if (normalized.startsWith('*.')) return filePath.endsWith(normalized.slice(1))
      if (normalized.includes('**/*')) return filePath.endsWith(normalized.split('**/*')[1])
      return filePath.includes(normalized.replace('*', ''))
    })
  }

  private extractSymbolsFromLine(line: string): Array<{ name: string; kind: string }> {
    const results: Array<{ name: string; kind: string }> = []
    const patterns: Array<{ kind: string; regex: RegExp }> = [
      { kind: 'class', regex: /(?:export\s+)?class\s+(\w+)/g },
      { kind: 'function', regex: /(?:export\s+)?function\s+(\w+)/g },
      { kind: 'const', regex: /(?:export\s+)?const\s+(\w+)\s*=/g },
      { kind: 'ipc', regex: /ipcMain\.handle\(\s*([^,)]+)/g },
      { kind: 'preload-api', regex: /contextBridge\.exposeInMainWorld\(\s*([^,)]+)/g },
    ]

    for (const pattern of patterns) {
      let match: RegExpExecArray | null
      while ((match = pattern.regex.exec(line)) !== null) {
        const raw = match[1].trim().replace(/^['"`]/, '').replace(/['"`]$/, '')
        results.push({ name: raw, kind: pattern.kind })
      }
    }
    return results
  }

  private async findExistingFiles(filePaths: string[]): Promise<string[]> {
    const result: string[] = []
    for (const filePath of filePaths) {
      if (await this.exists(filePath)) {
        result.push(filePath)
      }
    }
    return result
  }

  private async exists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(this.validatePath(relativePath))
      return true
    } catch {
      return false
    }
  }

  private async hashOptionalFile(relativePath: string): Promise<string | undefined> {
    try {
      const content = await fs.readFile(this.validatePath(relativePath))
      return createHash('sha256').update(content).digest('hex')
    } catch {
      return undefined
    }
  }

  private async hashFirstExisting(filePaths: string[]): Promise<string | undefined> {
    for (const filePath of filePaths) {
      const hash = await this.hashOptionalFile(filePath)
      if (hash) return hash
    }
    return undefined
  }

  private async readCache(): Promise<SnapshotCacheFile> {
    try {
      const content = await fs.readFile(this.cacheFilePath, 'utf-8')
      const parsed = JSON.parse(content) as SnapshotCacheFile
      return { entries: parsed.entries || {} }
    } catch {
      return { entries: {} }
    }
  }

  private async writeCache(cache: SnapshotCacheFile): Promise<void> {
    const dir = path.dirname(this.cacheFilePath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(this.cacheFilePath, JSON.stringify(cache, null, 2), 'utf-8')
  }
}
