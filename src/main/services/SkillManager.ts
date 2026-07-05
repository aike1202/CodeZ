import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type {
  SkillDefinition,
  ExternalSkillCheckResult,
  ExternalSourceCheck,
  ExternalSkillGroup,
  ExternalSkillItem
} from '../../shared/types/skill'
import { isBuiltinSkillName, BUILTIN_SKILL_NAMES, resolveBuiltinSkillsDir } from './BuiltinSkills'

export class SkillManager {
  private static instance: SkillManager
  private skillsCache: Map<string, SkillDefinition[]> = new Map()

  private constructor() {}

  public static getInstance(): SkillManager {
    if (!SkillManager.instance) {
      SkillManager.instance = new SkillManager()
    }
    return SkillManager.instance
  }

  private getGlobalSkillsDir(): string {
    return path.join(os.homedir(), '.codez', 'skills')
  }

  private getGlobalConfigPath(): string {
    return path.join(os.homedir(), '.codez', 'skills-config.json')
  }

  private async loadConfig(workspaceRoot: string | null): Promise<Record<string, boolean>> {
    const configPath = workspaceRoot
      ? path.join(workspaceRoot, '.codez-cache', 'skills-config.json')
      : this.getGlobalConfigPath()
    
    try {
      if (fs.existsSync(configPath)) {
        const content = await fs.promises.readFile(configPath, 'utf-8')
        return JSON.parse(content)
      }
    } catch (e) {
      console.error('Failed to load skills config:', e)
    }
    return {}
  }

  private async saveConfig(workspaceRoot: string | null, config: Record<string, boolean>): Promise<void> {
    const configPath = workspaceRoot
      ? path.join(workspaceRoot, '.codez-cache', 'skills-config.json')
      : this.getGlobalConfigPath()
      
    try {
      const dir = path.dirname(configPath)
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true })
      }
      await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
    } catch (e) {
      console.error('Failed to save skills config:', e)
    }
  }

  private async scanDir(dirPath: string, config: Record<string, boolean>, isGlobal: boolean): Promise<SkillDefinition[]> {
    const skills: SkillDefinition[] = []
    if (!fs.existsSync(dirPath)) return skills

    const processDir = async (currentDir: string) => {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name)
        if (entry.isDirectory()) {
          await processDir(fullPath)
        } else if (entry.isFile() && (entry.name === 'SKILL.md' || entry.name.endsWith('.skill.md'))) {
          const content = await fs.promises.readFile(fullPath, 'utf-8')
          const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
          if (match) {
            const frontmatter = match[1]
            const body = match[2].trim()
            
            const nameMatch = frontmatter.match(/name:\s*(.*)/)
            const descMatch = frontmatter.match(/description:\s*(.*)/)
            const triggersMatch = frontmatter.match(/triggers:\s*\[(.*?)\]/)

            let triggers: string[] = []
            if (triggersMatch && triggersMatch[1]) {
              triggers = triggersMatch[1].split(',').map(t => t.trim().replace(/['"]/g, '')).filter(Boolean)
            }

            const parentDirName = path.basename(path.dirname(fullPath))
            const fileName = path.basename(entry.name, entry.name === 'SKILL.md' ? '' : '.skill.md')
            const bareName = entry.name === 'SKILL.md' ? parentDirName : fileName
            const id = (isGlobal ? 'global-' : 'workspace-') + bareName

            skills.push({
              id,
              name: nameMatch ? nameMatch[1].trim() : id,
              description: descMatch ? descMatch[1].trim() : '',
              triggers,
              content: body,
              path: fullPath,
              enabled: config[id] !== false,
              isGlobal,
              builtin: isGlobal && isBuiltinSkillName(bareName)
            })
          }
        }
      }
    }

    await processDir(dirPath)
    return skills
  }

  /**
   * 将打包的内置技能同步到全局技能目录（覆盖，保证随应用升级更新内容）。
   * 找不到打包资源时静默跳过，不阻断技能扫描。
   */
  private async syncBuiltinSkills(): Promise<void> {
    const srcRoot = resolveBuiltinSkillsDir()
    if (!srcRoot) {
      console.warn('[SkillManager] builtin skills resource dir not found, skip sync')
      return
    }

    const globalDir = this.getGlobalSkillsDir()
    if (!fs.existsSync(globalDir)) {
      await fs.promises.mkdir(globalDir, { recursive: true })
    }

    for (const name of BUILTIN_SKILL_NAMES) {
      const src = path.join(srcRoot, name)
      try {
        if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue
        await this.copyDirectory(src, path.join(globalDir, name))
      } catch (e) {
        console.error(`[SkillManager] failed to sync builtin skill ${name}:`, e)
      }
    }
  }

  public async scanWorkspace(workspaceRoot: string | null): Promise<SkillDefinition[]> {
    await this.syncBuiltinSkills()
    
    let allSkills: SkillDefinition[] = []
    
    // 1. Scan global skills
    const globalConfig = await this.loadConfig(null)
    const globalSkills = await this.scanDir(this.getGlobalSkillsDir(), globalConfig, true)
    allSkills = allSkills.concat(globalSkills)

    // 2. Scan workspace skills if applicable
    if (workspaceRoot) {
      const workspaceSkillsDir = path.join(workspaceRoot, '.skills')
      const workspaceConfig = await this.loadConfig(workspaceRoot)
      const workspaceSkills = await this.scanDir(workspaceSkillsDir, workspaceConfig, false)
      allSkills = allSkills.concat(workspaceSkills)
    }

    const cacheKey = workspaceRoot || 'GLOBAL_ONLY'
    this.skillsCache.set(cacheKey, allSkills)
    return allSkills
  }

  public async getSkills(workspaceRoot: string | null): Promise<SkillDefinition[]> {
    const cacheKey = workspaceRoot || 'GLOBAL_ONLY'
    if (!this.skillsCache.has(cacheKey)) {
      return await this.scanWorkspace(workspaceRoot)
    }
    return this.skillsCache.get(cacheKey) || []
  }

  public async getActiveSkills(workspaceRoot: string | null): Promise<SkillDefinition[]> {
    const skills = await this.getSkills(workspaceRoot)
    return skills.filter(s => s.enabled)
  }

  /** 依 name 或 id 取命中 skill 的正文；未命中返回 null。 */
  public async getSkillContent(workspaceRoot: string | null, name: string): Promise<string | null> {
    const skills = await this.getSkills(workspaceRoot)
    const hit = skills.find(s => s.name === name || s.id === name)
    return hit ? hit.content : null
  }

  public async toggleSkill(workspaceRoot: string | null, id: string, enabled: boolean): Promise<void> {
    // 根据 ID 前缀判断该 Skill 属于 Global 还是 Workspace
    const isGlobal = id.startsWith('global-')
    
    // 强制使用对应的 root 和 config
    const targetRoot = isGlobal ? null : workspaceRoot
    const config = await this.loadConfig(targetRoot)
    config[id] = enabled
    await this.saveConfig(targetRoot, config)

    // 清空缓存，下次读取时自动重新 scan
    // 因为一个 skill 可能出现在多个 workspace cache key 里，简单粗暴清空缓存最安全
    this.skillsCache.clear()
  }

  /** 内置的外部工具技能目录（Codex / Claude）。 */
  private getExternalSourceDirs(): { name: string; path: string }[] {
    return [
      { name: 'Codex', path: path.join(os.homedir(), '.codex', 'skills') },
      { name: 'Claude', path: path.join(os.homedir(), '.claude', 'skills') }
    ]
  }

  /** 从 SKILL.md 解析 name / description；失败时回退到目录名。 */
  private readSkillMeta(skillMdPath: string, fallbackName: string): { name: string; description: string } {
    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8')
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
      if (match) {
        const frontmatter = match[1]
        const nameMatch = frontmatter.match(/name:\s*(.*)/)
        const descMatch = frontmatter.match(/description:\s*(.*)/)
        return {
          name: nameMatch ? nameMatch[1].trim() : fallbackName,
          description: descMatch ? descMatch[1].trim() : ''
        }
      }
    } catch (e) {
      console.error('Failed to read skill meta:', e)
    }
    return { name: fallbackName, description: '' }
  }

  /** 列出各外部工具下的单个技能，并标记其导入 / 可更新状态，供选择性导入使用。 */
  public async listExternalSkills(): Promise<ExternalSkillGroup[]> {
    const codezSkillsDir = this.getGlobalSkillsDir()
    const groups: ExternalSkillGroup[] = []

    for (const ext of this.getExternalSourceDirs()) {
      const skills: ExternalSkillItem[] = []
      if (fs.existsSync(ext.path)) {
        try {
          const entries = await fs.promises.readdir(ext.path, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.name.startsWith('.')) continue
            const srcSkillPath = path.join(ext.path, entry.name)
            let isDir = false
            try {
              isDir = fs.statSync(srcSkillPath).isDirectory()
            } catch (e) {}
            if (!isDir) continue

            const srcSkillMd = path.join(srcSkillPath, 'SKILL.md')
            if (!fs.existsSync(srcSkillMd)) continue

            const destSkillPath = path.join(codezSkillsDir, entry.name)
            const destSkillMd = path.join(destSkillPath, 'SKILL.md')
            const imported = fs.existsSync(destSkillMd)

            let hasUpdate = false
            if (imported) {
              try {
                const srcStat = fs.statSync(srcSkillMd)
                const destStat = fs.statSync(destSkillMd)
                hasUpdate = srcStat.mtimeMs > destStat.mtimeMs
              } catch (e) {}
            }

            const meta = this.readSkillMeta(srcSkillMd, entry.name)
            skills.push({
              dirName: entry.name,
              sourceName: ext.name,
              name: meta.name,
              description: meta.description,
              imported,
              hasUpdate
            })
          }
        } catch (e) {
          console.error(`Failed to list external skills in ${ext.name}:`, e)
        }
      }
      groups.push({ sourceName: ext.name, skills })
    }

    return groups
  }

  /** 导入单个指定技能（按来源工具与目录名定位），强制覆盖同名已导入技能。 */
  public async importSingleExternalSkill(sourceName: string, dirName: string): Promise<boolean> {
    const source = this.getExternalSourceDirs().find((s) => s.name === sourceName)
    if (!source) return false

    const srcSkillPath = path.join(source.path, dirName)
    if (!fs.existsSync(path.join(srcSkillPath, 'SKILL.md'))) return false

    const codezSkillsDir = this.getGlobalSkillsDir()
    if (!fs.existsSync(codezSkillsDir)) {
      await fs.promises.mkdir(codezSkillsDir, { recursive: true })
    }

    const copyDirectory = async (src: string, dest: string) => {
      if (!fs.existsSync(dest)) {
        await fs.promises.mkdir(dest, { recursive: true })
      }
      const entries = await fs.promises.readdir(src, { withFileTypes: true })
      for (const entry of entries) {
        const s = path.join(src, entry.name)
        const d = path.join(dest, entry.name)
        let isDir = false
        try {
          isDir = fs.statSync(s).isDirectory()
        } catch (e) {}
        if (isDir) {
          await copyDirectory(s, d)
        } else {
          await fs.promises.copyFile(s, d)
        }
      }
    }

    try {
      await copyDirectory(srcSkillPath, path.join(codezSkillsDir, dirName))
      this.skillsCache.clear()
      return true
    } catch (e) {
      console.error(`Failed to import skill ${dirName} from ${sourceName}:`, e)
      return false
    }
  }

  /** 删除一个已导入的技能（仅作用于 CodeZ 全局 / 工作区目录，不动外部源文件）。 */
  public async deleteSkill(workspaceRoot: string | null, id: string): Promise<boolean> {
    const skills = await this.getSkills(workspaceRoot)
    const target = skills.find((s) => s.id === id)
    if (!target || !target.path) return false

    // 内置技能受保护：不可删除
    if (target.builtin) {
      console.warn(`Refused to delete builtin skill: ${id}`)
      return false
    }

    // 技能目录 = SKILL.md 所在目录；.skill.md 单文件形式则删除文件本身。
    const isSkillMd = path.basename(target.path) === 'SKILL.md'
    const removeTarget = isSkillMd ? path.dirname(target.path) : target.path

    try {
      await fs.promises.rm(removeTarget, { recursive: true, force: true })

      // 同步清理 config 中残留的开关记录
      const targetRoot = target.isGlobal ? null : workspaceRoot
      const config = await this.loadConfig(targetRoot)
      if (id in config) {
        delete config[id]
        await this.saveConfig(targetRoot, config)
      }

      this.skillsCache.clear()
      return true
    } catch (e) {
      console.error(`Failed to delete skill ${id}:`, e)
      return false
    }
  }

  /** 递归复制目录（覆盖同名文件）。 */
  private async copyDirectory(src: string, dest: string): Promise<void> {
    if (!fs.existsSync(dest)) {
      await fs.promises.mkdir(dest, { recursive: true })
    }
    const entries = await fs.promises.readdir(src, { withFileTypes: true })
    for (const entry of entries) {
      const s = path.join(src, entry.name)
      const d = path.join(dest, entry.name)
      let isDir = false
      try {
        isDir = fs.statSync(s).isDirectory()
      } catch (e) {}
      if (isDir) {
        await this.copyDirectory(s, d)
      } else {
        await fs.promises.copyFile(s, d)
      }
    }
  }

  public async checkExternalSkills(): Promise<ExternalSkillCheckResult> {    let totalCount = 0
    const sourcesData: ExternalSourceCheck[] = []
    const codezSkillsDir = this.getGlobalSkillsDir()
    const externalDirs = [
      { name: 'Codex', path: path.join(os.homedir(), '.codex', 'skills') },
      { name: 'Claude', path: path.join(os.homedir(), '.claude', 'skills') }
    ]

    for (const ext of externalDirs) {
      let sourceCount = 0
      let totalSkillsInSource = 0
      
      if (fs.existsSync(ext.path)) {
        try {
          const entries = await fs.promises.readdir(ext.path, { withFileTypes: true })
          for (const entry of entries) {
            const srcSkillPath = path.join(ext.path, entry.name)
            let isDir = false
            try {
              isDir = fs.statSync(srcSkillPath).isDirectory()
            } catch (e) {}

            if (isDir && !entry.name.startsWith('.')) {
              const destSkillPath = path.join(codezSkillsDir, entry.name)
              if (fs.existsSync(path.join(srcSkillPath, 'SKILL.md'))) {
                totalSkillsInSource++
                let needsImport = false
                if (!fs.existsSync(destSkillPath)) {
                  needsImport = true
                } else {
                  const srcStat = fs.statSync(path.join(srcSkillPath, 'SKILL.md'))
                  const destStat = fs.statSync(path.join(destSkillPath, 'SKILL.md'))
                  if (srcStat.mtimeMs > destStat.mtimeMs) {
                    needsImport = true
                  }
                }

                if (needsImport) {
                  sourceCount++
                }
              }
            }
          }
        } catch (e) {
          console.error(`Failed to check external skills in ${ext.name}:`, e)
        }
      }

      sourcesData.push({ sourceName: ext.name, count: sourceCount })
      totalCount += sourceCount
    }

    return {
      hasUpdates: totalCount > 0,
      totalCount,
      sources: sourcesData
    }
  }

  public async importExternalSkills(sourceName?: string, customPath?: string, forceOverwrite: boolean = false): Promise<boolean> {
    const codezSkillsDir = this.getGlobalSkillsDir()
    let externalDirs = [
      { name: 'Codex', path: path.join(os.homedir(), '.codex', 'skills') },
      { name: 'Claude', path: path.join(os.homedir(), '.claude', 'skills') }
    ]

    if (customPath) {
      externalDirs = [{ name: 'CUSTOM', path: customPath }]
      forceOverwrite = true // 自定义导入默认强制覆盖
    }

    if (!fs.existsSync(codezSkillsDir)) {
      await fs.promises.mkdir(codezSkillsDir, { recursive: true })
    }

    const copyDirectory = async (src: string, dest: string) => {
      if (!fs.existsSync(dest)) {
        await fs.promises.mkdir(dest, { recursive: true })
      }
      const entries = await fs.promises.readdir(src, { withFileTypes: true })
      for (const entry of entries) {
        const srcPath = path.join(src, entry.name)
        const destPath = path.join(dest, entry.name)
        let isDir = false
        try { isDir = fs.statSync(srcPath).isDirectory() } catch (e) {}
        
        if (isDir) {
          await copyDirectory(srcPath, destPath)
        } else {
          await fs.promises.copyFile(srcPath, destPath)
        }
      }
    }

    let importedAnything = false

    for (const ext of externalDirs) {
      if (!customPath && sourceName && ext.name !== sourceName) continue
      if (!fs.existsSync(ext.path)) continue
      
      try {
        // 判断当前选中的目录本身是否就是一个独立的技能
        if (fs.existsSync(path.join(ext.path, 'SKILL.md'))) {
          const dirName = path.basename(ext.path)
          const destSkillPath = path.join(codezSkillsDir, dirName)
          await copyDirectory(ext.path, destSkillPath)
          importedAnything = true
          continue // 本身就是技能目录，无需再往下遍历子目录
        }

        const entries = await fs.promises.readdir(ext.path, { withFileTypes: true })
        for (const entry of entries) {
          const srcSkillPath = path.join(ext.path, entry.name)
          let isDir = false
          try {
            isDir = fs.statSync(srcSkillPath).isDirectory()
          } catch (e) {}

          if (isDir && !entry.name.startsWith('.')) {
            const destSkillPath = path.join(codezSkillsDir, entry.name)
            if (fs.existsSync(path.join(srcSkillPath, 'SKILL.md'))) {
              let needsImport = forceOverwrite
              if (!needsImport) {
                if (!fs.existsSync(destSkillPath)) {
                  needsImport = true
                } else {
                  const srcStat = fs.statSync(path.join(srcSkillPath, 'SKILL.md'))
                  const destStat = fs.statSync(path.join(destSkillPath, 'SKILL.md'))
                  if (srcStat.mtimeMs > destStat.mtimeMs) {
                    needsImport = true
                  }
                }
              }

              if (needsImport) {
                await copyDirectory(srcSkillPath, destSkillPath)
                importedAnything = true
              }
            }
          }
        }
      } catch (e) {
        console.error(`Failed to import external skills from ${ext.name}:`, e)
      }
    }

    if (importedAnything) {
      this.skillsCache.clear()
    }
    
    return importedAnything
  }
}
