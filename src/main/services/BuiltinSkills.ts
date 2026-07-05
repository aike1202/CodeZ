import * as fs from 'fs'
import * as path from 'path'

/** 系统内置技能目录名（同时也是精确小写触发名） */
export const BUILTIN_SKILL_NAMES = ['skill-creator', 'find-skills', 'rule-creator'] as const

/** 判断给定技能名是否为内置技能 */
export function isBuiltinSkillName(name: string): boolean {
  return (BUILTIN_SKILL_NAMES as readonly string[]).includes(name)
}

/**
 * 解析打包的内置技能资源目录（含 skill-creator/ find-skills/ rule-creator/ 三个子目录）。
 *
 * 优先级：
 * 1. `CODEZ_BUILTIN_SKILLS_DIR` 环境变量（测试覆盖用）。
 * 2. 打包后：`process.resourcesPath/builtin-skills`（electron-builder extraResources）。
 * 3. 开发期：项目根 `resources/builtin-skills`（相对 out/main 主进程为 ../../resources/...）。
 */
export function resolveBuiltinSkillsDir(): string | null {
  if (process.env.CODEZ_BUILTIN_SKILLS_DIR) {
    return process.env.CODEZ_BUILTIN_SKILLS_DIR
  }

  const candidates: string[] = []

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'builtin-skills'))
  }
  // 开发期：out/main/index.js -> 项目根 resources/builtin-skills
  candidates.push(path.join(__dirname, '..', '..', 'resources', 'builtin-skills'))
  // 兜底：cwd
  candidates.push(path.join(process.cwd(), 'resources', 'builtin-skills'))

  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        return dir
      }
    } catch {
      // 忽略无法访问的候选路径
    }
  }
  return null
}
