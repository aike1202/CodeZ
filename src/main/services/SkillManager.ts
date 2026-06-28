import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { SkillDefinition, ExternalSkillCheckResult, ExternalSourceCheck } from '../../shared/types/skill'

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
            const id = (isGlobal ? 'global-' : 'workspace-') + (entry.name === 'SKILL.md' ? parentDirName : fileName)

            skills.push({
              id,
              name: nameMatch ? nameMatch[1].trim() : id,
              description: descMatch ? descMatch[1].trim() : '',
              triggers,
              content: body,
              path: fullPath,
              enabled: config[id] !== false,
              isGlobal
            })
          }
        }
      }
    }

    await processDir(dirPath)
    return skills
  }

  private async initializeGlobalSkillsIfNeeded(): Promise<void> {
    const globalDir = this.getGlobalSkillsDir()
    if (!fs.existsSync(globalDir)) {
      await fs.promises.mkdir(globalDir, { recursive: true })
      // Create a default built-in skill
      const defaultSkillDir = path.join(globalDir, 'Code-Review')
      await fs.promises.mkdir(defaultSkillDir, { recursive: true })
      const defaultSkillContent = `---
name: 代码审查专家
description: 全局常驻技能：作为一个严苛但友善的资深代码审查员，帮我找出潜在问题。
triggers: [code-review, review, 代码审查]
---
你现在是一个拥有 10 年经验的架构师和代码审查专家。
每次我发代码给你，你必须：
1. 找出潜在的 Bug 和内存泄漏。
2. 提出性能优化的建议。
3. 检查是否符合 SOLID 原则。
请保持回复简明扼要，直接指出核心问题！`
      await fs.promises.writeFile(path.join(defaultSkillDir, 'SKILL.md'), defaultSkillContent, 'utf-8')
    }
  }

  public async scanWorkspace(workspaceRoot: string | null): Promise<SkillDefinition[]> {
    await this.initializeGlobalSkillsIfNeeded()
    
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

  public async checkExternalSkills(): Promise<ExternalSkillCheckResult> {
    let totalCount = 0
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
