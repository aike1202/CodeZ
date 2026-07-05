import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { SkillManager } from '../main/services/SkillManager'

let home: string

// SkillManager 内部用 os.homedir() 定位 ~/.codez；用可变闭包变量指向每个用例的临时目录。
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    default: { ...actual, homedir: () => home },
    homedir: () => home
  }
})

async function writeSkill(dir: string, name: string): Promise<void> {
  const skillDir = path.join(dir, name)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test ${name}\n---\nbody`,
    'utf-8'
  )
}

describe('SkillManager builtin', () => {
  beforeEach(() => {
    home = path.join(os.tmpdir(), `codez-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    // 隔离测试：默认指向不存在的 bundle 资源，避免读到真实系统技能
    process.env.CODEZ_BUILTIN_SKILLS_DIR = path.join(home, 'no-such-dir')
    // 重置单例
    ;(SkillManager as any)['instance'] = undefined
  })
  afterEach(async () => {
    delete process.env.CODEZ_BUILTIN_SKILLS_DIR
    await fs.rm(home, { recursive: true, force: true })
  })

  it('系统技能从 bundle 只读扫描，id 带 builtin- 前缀且标记 builtin', async () => {
    // 造一个假的 bundle 资源目录，含内置技能名之一
    const resDir = path.join(home, 'builtin-res')
    await writeSkill(resDir, 'skill-creator')
    process.env.CODEZ_BUILTIN_SKILLS_DIR = resDir

    ;(SkillManager as any)['instance'] = undefined
    const sm = SkillManager.getInstance()
    const skills = await sm.scanWorkspace(null)

    const creator = skills.find((s) => s.id === 'builtin-skill-creator')
    expect(creator).toBeDefined()
    expect(creator?.builtin).toBe(true)
    expect(creator?.isGlobal).toBe(true)
  })

  it('系统技能不会被复制到 ~/.codez/skills', async () => {
    const resDir = path.join(home, 'builtin-res')
    await writeSkill(resDir, 'skill-creator')
    process.env.CODEZ_BUILTIN_SKILLS_DIR = resDir

    ;(SkillManager as any)['instance'] = undefined
    const sm = SkillManager.getInstance()
    await sm.scanWorkspace(null)

    // 全局用户技能目录不应出现被复制的系统技能
    const copiedExists = await fs
      .stat(path.join(home, '.codez', 'skills', 'skill-creator'))
      .then(() => true)
      .catch(() => false)
    expect(copiedExists).toBe(false)
  })

  it('用户全局技能 id 带 global- 前缀、非 builtin', async () => {
    const globalDir = path.join(home, '.codez', 'skills')
    await writeSkill(globalDir, 'my-custom')

    const sm = SkillManager.getInstance()
    const skills = await sm.scanWorkspace(null)

    const custom = skills.find((s) => s.id === 'global-my-custom')
    expect(custom?.builtin).toBe(false)
    expect(custom?.isGlobal).toBe(true)
  })

  it('deleteSkill 拒绝删除系统技能', async () => {
    const resDir = path.join(home, 'builtin-res')
    await writeSkill(resDir, 'skill-creator')
    process.env.CODEZ_BUILTIN_SKILLS_DIR = resDir

    ;(SkillManager as any)['instance'] = undefined
    const sm = SkillManager.getInstance()
    await sm.scanWorkspace(null)
    const ok = await sm.deleteSkill(null, 'builtin-skill-creator')
    expect(ok).toBe(false)

    // bundle 源文件仍存在
    const stat = await fs.stat(path.join(resDir, 'skill-creator'))
    expect(stat.isDirectory()).toBe(true)
  })

  it('toggleSkill 停用系统技能：开关存全局 config，再次扫描时 enabled=false', async () => {
    const resDir = path.join(home, 'builtin-res')
    await writeSkill(resDir, 'skill-creator')
    process.env.CODEZ_BUILTIN_SKILLS_DIR = resDir

    ;(SkillManager as any)['instance'] = undefined
    const sm = SkillManager.getInstance()
    await sm.scanWorkspace(null)

    await sm.toggleSkill(null, 'builtin-skill-creator', false)
    const skills = await sm.scanWorkspace(null)
    const creator = skills.find((s) => s.id === 'builtin-skill-creator')
    expect(creator?.enabled).toBe(false)
  })

  it('清理旧版遗留：~/.codez/skills 下与系统技能同名的复制体会被移除', async () => {
    // 模拟旧版行为遗留的复制体
    const globalDir = path.join(home, '.codez', 'skills')
    await writeSkill(globalDir, 'skill-creator')
    await writeSkill(globalDir, 'my-custom')

    const sm = SkillManager.getInstance()
    const skills = await sm.scanWorkspace(null)

    // 同名复制体被删除，且不作为用户技能出现
    const legacyExists = await fs
      .stat(path.join(globalDir, 'skill-creator'))
      .then(() => true)
      .catch(() => false)
    expect(legacyExists).toBe(false)
    expect(skills.find((s) => s.id === 'global-skill-creator')).toBeUndefined()
    // 普通用户技能不受影响
    expect(skills.find((s) => s.id === 'global-my-custom')).toBeDefined()
  })
})
